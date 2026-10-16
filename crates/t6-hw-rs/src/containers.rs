//! Docker containers, for 总览's 容器 module: name, image and whether each
//! runs. Read with the docker CLI (t6-paneld runs as root); managing them
//! stays in the fnOS web page.

use serde::Serialize;
use std::process::Command;

const DOCKER: &str = "/usr/bin/docker";

#[derive(Serialize)]
pub struct Container {
    pub name: String,
    pub image: String,
    pub running: bool,
}

#[derive(Serialize)]
pub struct Containers {
    /// Docker is installed and answering.
    pub available: bool,
    pub items: Vec<Container>,
}

pub fn list() -> Containers {
    let out = Command::new(DOCKER).args(["ps", "-a", "--format", "{{json .}}"]).output().ok();
    let Some(out) = out.filter(|o| o.status.success()) else {
        return Containers { available: false, items: Vec::new() };
    };
    let mut items: Vec<Container> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .map(|c| {
            let image = c["Image"].as_str().unwrap_or("");
            // "ghcr.io/immich-app/immich-server:release" → "immich-server"
            let short = image.rsplit('/').next().unwrap_or(image).split([':', '@']).next().unwrap_or(image);
            Container {
                name: c["Names"].as_str().unwrap_or("").to_string(),
                image: short.to_string(),
                running: c["State"].as_str() == Some("running"),
            }
        })
        .collect();
    items.sort_by(|a, b| b.running.cmp(&a.running).then(a.name.cmp(&b.name)));
    Containers { available: true, items }
}
