//! Readings over time, for the panel's charts (`GET /api/history`).
//!
//! A small round-robin store in the spirit of RRDtool, without its C library:
//! each series keeps four archives — one point a minute for a day, every five
//! minutes for a week, every hour for 90 days, every day for two years — and
//! each point holds the average and the maximum of the samples in its bucket.
//!
//! A background task samples every 10 s. Files live in [`DIR`], one per group:
//! `system` (cpu, mem, gpu, cpu temperature, network) and one per volume
//! (`vol1`, `vol2`: used bytes). They are written every [`SAVE_EVERY`] and on
//! shutdown, so a crash loses at most that much. A file whose layout no
//! longer matches the archives below is set aside and started afresh.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DIR: &str = "/var/lib/t6-paneld/history";
const SAMPLE_EVERY: Duration = Duration::from_secs(10);
const SAVE_EVERY: Duration = Duration::from_secs(10 * 60);
/// (seconds per point, points kept)
const ARCHIVES: [(i64, usize); 4] = [(60, 1440), (300, 2016), (3600, 2160), (86400, 730)];
const MAGIC: &[u8; 4] = b"T6H1";

// ---- one archive ---------------------------------------------------------

struct Archive {
    step: i64,
    avg: Vec<f32>,
    max: Vec<f32>,
    /// The bucket being filled (time / step); its samples are not in the ring yet.
    cur: i64,
    sum: f64,
    n: u32,
    mx: f32,
}

impl Archive {
    fn new(step: i64, rows: usize) -> Self {
        Archive { step, avg: vec![f32::NAN; rows], max: vec![f32::NAN; rows], cur: 0, sum: 0.0, n: 0, mx: f32::MIN }
    }

    fn rows(&self) -> i64 {
        self.avg.len() as i64
    }

    fn idx(&self, slot: i64) -> usize {
        slot.rem_euclid(self.rows()) as usize
    }

    fn add(&mut self, t: i64, v: f32) {
        let slot = t.div_euclid(self.step);
        if slot != self.cur {
            self.commit();
            // buckets nothing was sampled in (the NAS was off) read as gaps
            if self.cur > 0 {
                for s in (self.cur + 1)..slot.min(self.cur + 1 + self.rows()) {
                    let i = self.idx(s);
                    self.avg[i] = f32::NAN;
                    self.max[i] = f32::NAN;
                }
            }
            self.cur = slot;
            self.sum = 0.0;
            self.n = 0;
            self.mx = f32::MIN;
        }
        self.sum += v as f64;
        self.n += 1;
        self.mx = self.mx.max(v);
    }

    fn commit(&mut self) {
        if self.n == 0 {
            return;
        }
        let i = self.idx(self.cur);
        self.avg[i] = (self.sum / self.n as f64) as f32;
        self.max[i] = self.mx;
    }

    /// Points from `from` (unix s) to now, oldest first, as (time, avg, max);
    /// the bucket still being filled is the last point.
    fn read(&self, from: i64) -> Vec<(i64, f32, f32)> {
        let first = (from.div_euclid(self.step)).max(self.cur - self.rows() + 1);
        let mut out = Vec::new();
        for s in first..self.cur {
            let i = self.idx(s);
            if !self.avg[i].is_nan() {
                out.push((s * self.step, self.avg[i], self.max[i]));
            }
        }
        if self.n > 0 {
            out.push((self.cur * self.step, (self.sum / self.n as f64) as f32, self.mx));
        }
        out
    }

    fn write(&self, w: &mut impl Write) -> std::io::Result<()> {
        w.write_all(&self.step.to_le_bytes())?;
        w.write_all(&(self.avg.len() as u32).to_le_bytes())?;
        w.write_all(&self.cur.to_le_bytes())?;
        w.write_all(&self.sum.to_le_bytes())?;
        w.write_all(&self.n.to_le_bytes())?;
        w.write_all(&self.mx.to_le_bytes())?;
        for i in 0..self.avg.len() {
            w.write_all(&self.avg[i].to_le_bytes())?;
            w.write_all(&self.max[i].to_le_bytes())?;
        }
        Ok(())
    }

    fn load(r: &mut impl Read, step: i64, rows: usize) -> Option<Self> {
        let mut a = Archive::new(step, rows);
        if read_i64(r)? != step || read_u32(r)? as usize != rows {
            return None;
        }
        a.cur = read_i64(r)?;
        a.sum = f64::from_le_bytes(read_n(r)?);
        a.n = read_u32(r)?;
        a.mx = f32::from_le_bytes(read_n(r)?);
        for i in 0..rows {
            a.avg[i] = f32::from_le_bytes(read_n(r)?);
            a.max[i] = f32::from_le_bytes(read_n(r)?);
        }
        Some(a)
    }
}

fn read_n<const N: usize>(r: &mut impl Read) -> Option<[u8; N]> {
    let mut b = [0u8; N];
    r.read_exact(&mut b).ok()?;
    Some(b)
}
fn read_i64(r: &mut impl Read) -> Option<i64> {
    Some(i64::from_le_bytes(read_n(r)?))
}
fn read_u32(r: &mut impl Read) -> Option<u32> {
    Some(u32::from_le_bytes(read_n(r)?))
}

// ---- a series and a group of them (one file) -------------------------------

struct Series {
    archives: Vec<Archive>,
}

impl Series {
    fn new() -> Self {
        Series { archives: ARCHIVES.iter().map(|&(s, r)| Archive::new(s, r)).collect() }
    }

    fn add(&mut self, t: i64, v: f32) {
        for a in &mut self.archives {
            a.add(t, v);
        }
    }
}

#[derive(Default)]
struct Group {
    series: BTreeMap<String, Series>,
    dirty: bool,
}

impl Group {
    fn add(&mut self, name: &str, t: i64, v: f32) {
        if !v.is_finite() {
            return;
        }
        self.series.entry(name.to_string()).or_insert_with(Series::new).add(t, v);
        self.dirty = true;
    }

    fn save(&mut self, path: &Path) -> std::io::Result<()> {
        let tmp = path.with_extension("tmp");
        let mut w = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
        w.write_all(MAGIC)?;
        w.write_all(&(self.series.len() as u32).to_le_bytes())?;
        for (name, s) in &self.series {
            w.write_all(&(name.len() as u16).to_le_bytes())?;
            w.write_all(name.as_bytes())?;
            for a in &s.archives {
                a.write(&mut w)?;
            }
        }
        w.flush()?;
        drop(w);
        std::fs::rename(&tmp, path)?;
        self.dirty = false;
        Ok(())
    }

    fn load(path: &Path) -> Option<Group> {
        let mut r = std::io::BufReader::new(std::fs::File::open(path).ok()?);
        if &read_n::<4>(&mut r)? != MAGIC {
            return None;
        }
        let mut g = Group::default();
        for _ in 0..read_u32(&mut r)? {
            let len = u16::from_le_bytes(read_n(&mut r)?) as usize;
            let mut name = vec![0u8; len];
            r.read_exact(&mut name).ok()?;
            let mut archives = Vec::new();
            for &(step, rows) in &ARCHIVES {
                archives.push(Archive::load(&mut r, step, rows)?);
            }
            g.series.insert(String::from_utf8(name).ok()?, Series { archives });
        }
        Some(g)
    }
}

// ---- the store -------------------------------------------------------------

static STORE: Mutex<BTreeMap<String, Group>> = Mutex::new(BTreeMap::new());

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn file_of(group: &str) -> PathBuf {
    Path::new(DIR).join(format!("{group}.hist"))
}

fn record(group: &str, name: &str, t: i64, v: f32) {
    let mut store = STORE.lock().unwrap();
    let g = store.entry(group.to_string()).or_insert_with(|| {
        let path = file_of(group);
        Group::load(&path).unwrap_or_else(|| {
            if path.exists() {
                let _ = std::fs::rename(&path, path.with_extension("old"));
            }
            Group::default()
        })
    });
    g.add(name, t, v);
}

/// Write every group that changed since it was last written.
pub fn save_all() {
    let _ = std::fs::create_dir_all(DIR);
    let mut store = STORE.lock().unwrap();
    for (name, g) in store.iter_mut() {
        if g.dirty {
            if let Err(e) = g.save(&file_of(name)) {
                eprintln!("history: cannot save {name}: {e}");
            }
        }
    }
}

/// How much history a range shows, and the archive to read it from (one
/// with enough resolution for a small chart, but not thousands of points).
fn range(spec: &str) -> Option<(i64, usize)> {
    Some(match spec {
        "1h" => (3600, 0),
        "24h" => (86400, 1),
        "7d" => (7 * 86400, 2),
        "30d" => (30 * 86400, 2),
        "90d" => (90 * 86400, 3),
        "1y" => (365 * 86400, 3),
        _ => return None,
    })
}

/// A metric is `group/name`, e.g. `system/cpu` or `vol1/used`.
pub fn query(metric: &str, spec: &str) -> Result<serde_json::Value, String> {
    let (span, arch) = range(spec).ok_or("range is one of 1h, 24h, 7d, 30d, 90d, 1y")?;
    let (group, name) = metric.split_once('/').ok_or("metric is group/name")?;
    let store = STORE.lock().unwrap();
    let points: Vec<[f64; 3]> = store
        .get(group)
        .and_then(|g| g.series.get(name))
        .map(|s| {
            let a = &s.archives[arch];
            a.read(now() - span).into_iter().map(|(t, avg, max)| [t as f64, avg as f64, max as f64]).collect()
        })
        .unwrap_or_default();
    Ok(serde_json::json!({ "metric": metric, "range": spec, "step": ARCHIVES[arch].0, "points": points }))
}

// ---- sampling --------------------------------------------------------------

fn sample(prev_net: &mut Option<(i64, u64, u64)>) {
    let t = now();
    let s = t6_hw_rs::sysmon::snapshot();
    let f = |v: &serde_json::Value| v.as_f64().map(|x| x as f32);
    if let Some(v) = f(&s["cpu"]["busy"]["total"]) {
        record("system", "cpu", t, v);
    }
    if let Some(v) = f(&s["cpu"]["temp_c"]) {
        record("system", "temp", t, v);
    }
    if let Some(v) = f(&s["mem"]["used_pct"]) {
        record("system", "mem", t, v);
    }
    if let Some(v) = f(&s["gpu"]["busy"]) {
        record("system", "gpu", t, v);
    }
    let c = t6_hw_rs::net::counters();
    if let Some((pt, prx, ptx)) = *prev_net {
        let dt = (t - pt).max(1) as f32;
        record("system", "rx", t, c.rx_bytes.saturating_sub(prx) as f32 / dt);
        record("system", "tx", t, c.tx_bytes.saturating_sub(ptx) as f32 / dt);
    }
    *prev_net = Some((t, c.rx_bytes, c.tx_bytes));
    for v in t6_hw_rs::storage::volumes() {
        let id = v.mount.trim_start_matches('/').replace('/', "_");
        record(&id, "used", t, v.used_bytes as f32);
    }
}

/// Start sampling in the background.
pub fn start() {
    std::thread::spawn(|| {
        let mut prev_net = None;
        let mut last_save = std::time::Instant::now();
        loop {
            sample(&mut prev_net);
            if last_save.elapsed() >= SAVE_EVERY {
                save_all();
                last_save = std::time::Instant::now();
            }
            std::thread::sleep(SAMPLE_EVERY);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_average_and_max() {
        let mut a = Archive::new(60, 5);
        for (t, v) in [(600, 1.0), (610, 3.0), (660, 10.0)] {
            a.add(t, v);
        }
        assert_eq!(a.read(0), vec![(600, 2.0, 3.0), (660, 10.0, 10.0)]);
    }

    #[test]
    fn gaps_and_wraparound() {
        let mut a = Archive::new(60, 3);
        a.add(60, 1.0);
        a.add(120, 2.0);
        a.add(600, 5.0); // long gap: older points fall out of the 3-point ring
        assert_eq!(a.read(0), vec![(600, 5.0, 5.0)]);
    }

    #[test]
    fn save_and_load() {
        let mut g = Group::default();
        g.add("cpu", 6000, 4.0);
        g.add("cpu", 6060, 6.0);
        let path = std::env::temp_dir().join(format!("t6-hist-{}.hist", std::process::id()));
        g.save(&path).unwrap();
        let back = Group::load(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(back.series["cpu"].archives[0].read(0), g.series["cpu"].archives[0].read(0));
    }
}
