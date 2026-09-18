# T6 Panel — "System" page: content spec for design

The System page is the sub-page behind the home screen's **CPU · GPU · Memory · Drives + Fans** card.
It is a **local resource monitor**: every value comes from the device itself (`/proc`, sysfs), so the
page works **without any fnOS sign-in**. It refreshes **every 2 s** while open.

## Canvas & context
- Portrait touch panel, **1080 × 2160 px** (designs are authored at that size; the app renders at 2× DPR = 540 × 1080 DIP).
- Dark UI, `IBM Plex Sans`, amber accent `oklch(0.78 0.11 62)`, background `oklch(0.15 0.035 252)`, cards `oklch(0.22 0.038 252 / .92)` with hairline borders `oklch(1 0 0 / .08)`.
- It uses the app's **Settings-style sub-page** shell: status bar (clock + "System" crumb), big title **System**, a **Done** pill top-right, then a scrolling column of section cards. Sections have a small uppercase label above each card (matching the Settings screen).
- Read-only. No actions on this page (no "kill process" etc.). The only related control lives in Settings → Cooling (fan profile).

## Data model (one `GET /api/sysmon` snapshot)
All numbers are live. Anything not available on a given box is `null` and the UI shows "—" or hides the row. Rates and busy-% are **deltas between two polls**, so the very first paint after opening shows "—" for those for ~2 s.

### 1. Overview
| Field | Meaning | Example |
|---|---|---|
| Hostname | device name | `MeteorLake` |
| Uptime | since boot, `Nd Nh` / `Nh Nm` / `Nm` | `2d 15h` (227 141 s) |
| Processor | model | `Intel(R) Core(TM) Ultra 5 125H` |
| Threads | logical CPUs | `18` |
| Clock now / max | current & max frequency, GHz | `2.00 GHz now · 4.5 max` |

### 2. CPU
| Field | Meaning | Example | Notes |
|---|---|---|---|
| Usage | total busy % (of all threads), with a bar | `7.9%` | 0–100 |
| user / system / I/O wait | split of that busy % | `user 5.8% · system 2.0% · I/O wait 1.3%` | I/O wait is the interesting one on a NAS |
| Load average | 1 · 5 · 15 min | `0.93 · 1.35 · 1.43` | can exceed thread count |
| Temperature | package temp, °C | `54°` | |

### 3. Memory — the headline insight of the page
"83 % used" on the home tile is misleading on a ZFS box: a third of it is reclaimable cache. This section shows a **stacked bar with four segments** + legend:

| Segment | Meaning | Example | Colour intent |
|---|---|---|---|
| **Apps** | memory processes actually hold | `15.5 GB` | amber (the "real" usage) |
| **ZFS cache** | ZFS ARC — reclaimable read cache. **Only present when ZFS is loaded**; on ext4/btrfs boxes this segment and legend entry are absent (3 segments) | `10.2 GB` | blue-ish, secondary |
| **File cache** | page cache + buffers, reclaimable | `4.4 GB` | dim |
| **Free** | untouched | `1.3 GB` | faint |

Also: header value `In use 25.7 GB / 30.9 GB`, and a sub-line `5.1 GB available to apps · no swap` (or `swap 0.0 GB / 8.0 GB`).

### 4. Graphics & AI
| Field | Meaning | Example | Notes |
|---|---|---|---|
| GPU name | | `Meteor Lake-P [Intel Arc Graphics]` | |
| GPU busy | % time not idle, with a bar | `59.1%` | on this box the kiosk renderer keeps it ~60 % |
| GPU clock | current / max MHz | `800 / 2200 MHz` | |
| GPU temp | °C | `53°` | |
| **Throttling** | list of active throttle reasons; **normally empty** | `throttling: pl1, thermal` (rare) | shown in amber when non-empty — worth a distinct treatment |
| NPU name | | `Intel AI Boost` | |
| NPU state | busy % **or "Idle"** when asleep | `Idle` (power_state `D3hot`, 0 / 1400 MHz) | most of the time it is idle |

### 5. Fans (3 fans on the T6)
| Field | Example |
|---|---|
| name · rpm | `CPU fan — 1801 rpm` |
| duty · zone temp | `32% duty · zone 54°` |
| | `SSD bay 1-2 fan — 2642 rpm · 24% duty · zone 40°` |
| | `SSD bay 3-6 fan — 2513 rpm · 24% duty · zone 41°` |

### 6. Disks (whole devices; empty card-reader slots are hidden)
| Field | Meaning | Example |
|---|---|---|
| name | block device | `nvme2n1` |
| model · size · temp | | `Samsung SSD 990 EVO Plus 2TB · 2.0 TB · 41°` |
| busy | % of time with I/O in flight | `0.4%` |
| read / write | throughput right now | `↓ 0 B/s · ↑ 81 KB/s` |
| | (temp is `null` for non-NVMe, e.g. the eMMC card reader) | `sdb — eMMC Reader 1.0 · 31.3 GB` |

Typical set on this box: two 4.1 TB GLOWAY NVMe (data, ~40°), one 2 TB Samsung 990 EVO Plus (system, ~41°), one 31 GB eMMC reader.

### 7. Top processes · N running
Header carries the live count (`287 running`). Two short lists, 5 rows each:
- **By CPU** — `name`, `pid`, `cpu %` (of total CPU): e.g. `electron 1.1%`, `qemu-system-x86 0.9%`, `weston 0.4%`
- **By memory** — `name`, `pid`, resident size: e.g. `qemu-system-x86 8.1 GB`, `claude 677 MB`, `immich 442 MB`, `immich-api 315 MB`, `ovs-vswitchd 210 MB`

Read-only; no kill action by design.

## States to design for
- **Cold open** (first ~2 s): usage/throughput/busy values show "—"; everything else is instant.
- **No ZFS**: memory bar has 3 segments (Apps / File cache / Free).
- **No NPU / no GPU**: that row (or the whole "Graphics & AI" card) is omitted.
- **Throttling active**: amber "throttling: …" text under the GPU row.
- **Fans**: always 3 on the T6; a fan at 0 rpm while duty > 0 is a fault (the home banner already flags it).
- **Signed out**: identical — this page never needs a login.

## Raw sample (one real snapshot from the box)
```json
{
 "uptime_s": 227141, "sample_dt_s": 2.11,
 "cpu": {"model":"Intel(R) Core(TM) Ultra 5 125H","threads":18,"load":[0.93,1.35,1.43],
         "busy":{"total":7.9,"user":5.8,"system":2.0,"iowait":1.3},"freq_mhz":1999,"max_freq_mhz":4500,"temp_c":54.0},
 "mem": {"total":33154461696,"used":27633672192,"apps":16662448752,"zfs_arc":10971223440,"cached":4709429248,
         "free":1436626944,"available":5520789504,"swap_total":0,"swap_used":0,"used_pct":83.0},
 "gpu": {"name":"Intel Corporation Meteor Lake-P [Intel Arc Graphics] (rev 08)","busy":59.1,"freq_mhz":800,"max_freq_mhz":2200,"temp_c":53.0,"throttle":[]},
 "npu": {"name":"Intel AI Boost","busy":0.0,"freq_mhz":0,"max_freq_mhz":1400,"power_state":"D3hot"},
 "fans": [{"name":"CPU fan","rpm":1801,"pwm_percent":32,"temp_c":54.0,"zone":"cpu"},
          {"name":"SSD bay 1-2 fan","rpm":2642,"pwm_percent":24,"temp_c":39.85,"zone":"ssd12"},
          {"name":"SSD bay 3-6 fan","rpm":2513,"pwm_percent":24,"temp_c":40.85,"zone":"ssd36"}],
 "disks": [{"name":"nvme0n1","model":"GLOWAY YCQ4TNVMe-M.2/80","size_bytes":4096805658624,"ssd":true,"temp_c":40.0,"io":{"busy":0.0,"read_bps":0.0,"write_bps":0.0}},
           {"name":"nvme1n1","model":"GLOWAY YCQ4TNVMe-M.2/80","size_bytes":4096805658624,"ssd":true,"temp_c":40.0,"io":{"busy":0.0,"read_bps":0.0,"write_bps":0.0}},
           {"name":"nvme2n1","model":"Samsung SSD 990 EVO Plus 2TB","size_bytes":2000398934016,"ssd":true,"temp_c":41.0,"io":{"busy":0.4,"read_bps":0.0,"write_bps":81429.3}},
           {"name":"sdb","model":"eMMC Reader  1.0","size_bytes":31268536320,"ssd":false,"temp_c":null,"io":{"busy":0.0,"read_bps":0.0,"write_bps":0.0}}],
 "procs": {"count":287,
           "top_cpu":[{"name":"electron","pid":2901679,"cpu":1.1,"rss":197177344},{"name":"qemu-system-x86","pid":5679,"cpu":0.9,"rss":8654299136},
                      {"name":"weston","pid":2901686,"cpu":0.4,"rss":96202752},{"name":"claude","pid":8527,"cpu":0.3,"rss":710217728},{"name":"NetworkManager","pid":1389,"cpu":0.2,"rss":21151744}],
           "top_mem":[{"name":"qemu-system-x86","pid":5679,"cpu":0.9,"rss":8654299136},{"name":"claude","pid":8527,"cpu":0.3,"rss":710217728},
                      {"name":"immich","pid":3800,"cpu":0.0,"rss":463171584},{"name":"immich-api","pid":4298,"cpu":0.0,"rss":330076160},{"name":"ovs-vswitchd","pid":1612,"cpu":0.0,"rss":219688960}]}
}
```
