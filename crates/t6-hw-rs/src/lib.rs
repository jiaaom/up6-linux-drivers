//! t6-hw-rs: userspace hardware readers for UnifyDrive UP6/T6.
//!
//! Pure "read the box" helpers (sysfs, `/proc`, and the daemons' run files),
//! with no HTTP or policy. Shared by the two backends that both need the same
//! numbers: `t6-webd` (Control Center web UI) and `t6-paneld` (front panel).

pub mod battery;
pub mod display;
pub mod fans;
pub mod hwinfo;
pub mod leds;
pub mod net;
pub mod network;
pub mod sensors;
pub mod sharing;
pub mod ssh;
pub mod storage;
pub mod sysmon;
pub mod thunderbolt;
