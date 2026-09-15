//! Aggregate network byte counters from `/proc/net/dev`.
//!
//! We sum the physical interfaces (`en*`, `eth*`, `wl*`) and skip virtual
//! ones — including the `-ovs` bridge port, which mirrors its physical NIC and
//! would double-count. Callers read the cumulative counters on successive
//! polls and difference them to get a throughput rate.

use serde::Serialize;

#[derive(Debug, Serialize, PartialEq)]
pub struct Counters {
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

fn is_physical(iface: &str) -> bool {
    (iface.starts_with("en") || iface.starts_with("eth") || iface.starts_with("wl")) && !iface.contains('-')
}

fn parse(procnetdev: &str) -> Counters {
    let mut rx = 0u64;
    let mut tx = 0u64;
    for line in procnetdev.lines() {
        let Some((iface, rest)) = line.split_once(':') else { continue };
        if !is_physical(iface.trim()) {
            continue;
        }
        let f: Vec<u64> = rest.split_whitespace().filter_map(|x| x.parse().ok()).collect();
        // rx_bytes is field 0, tx_bytes is field 8 (rx has 8 columns first).
        if f.len() >= 9 {
            rx += f[0];
            tx += f[8];
        }
    }
    Counters { rx_bytes: rx, tx_bytes: tx }
}

pub fn counters() -> Counters {
    parse(&std::fs::read_to_string("/proc/net/dev").unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_physical_skips_virtual_and_ovs() {
        let s = "\
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets
    lo: 1000 1 0 0 0 0 0 0 2000 1 0 0 0 0 0 0
enp103s0: 100 1 0 0 0 0 0 0 50 1 0 0 0 0 0 0
enp103s0-ovs: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0
wlp0s20f3: 25 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0
docker0: 7 1 0 0 0 0 0 0 7 1 0 0 0 0 0 0";
        assert_eq!(parse(s), Counters { rx_bytes: 125, tx_bytes: 55 });
    }
}
