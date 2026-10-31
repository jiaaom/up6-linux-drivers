#!/bin/sh
# Pretend the Wi-Fi network sits behind a captive portal, to test the
# sign-in detection (docs/captive-portal-plan.md) without a hotel:
#
#   sudo panel/tools/fake-captive-portal.sh up      # Wi-Fi now "needs sign-in"
#   sudo panel/tools/fake-captive-portal.sh up meraki  # the same, as a Meraki page
#   sudo panel/tools/fake-captive-portal.sh status  # what NM, the LED and routes say
#   sudo panel/tools/fake-captive-portal.sh down    # back to normal
#
# `up` starts a tiny HTTP server on the Wi-Fi address and an nftables rule
# that sends port-80 traffic leaving the Wi-Fi interface to it; wired traffic
# is untouched. Like a Cisco Meraki click-through portal, the server answers
# every request with a 302 to its splash page (served as
# http://example.com/__t6-fake-portal/, which the same rule catches), which
# has a "Room number" field and a Connect button. Connect "signs in": it
# removes the nftables rule and sends the browser back where it was going.
# `up meraki` imitates Cisco Meraki's click-through page instead (what
# t6-paneld accepts by itself, autoaccept.rs): http://example.com/splash/
# FAKE.1/ with a cookie and a "Continue to the Internet" link to …/grant,
# which refuses a request without the cookie. t6-paneld only takes it for
# Meraki with T6_PANELD_FAKE_PORTAL_HOST=example.com in its environment
# (a systemd drop-in; remove it after testing).
# `down` removes whatever is left.
# Wi-Fi must be connected; keep the wired link up so this machine stays
# reachable.
set -eu

TABLE=t6fakeportal
PORT=8099
PIDFILE=/run/t6-fake-portal.pid

wifi_iface() {
    for p in /sys/class/net/wl*; do
        n=${p##*/}
        case $n in *-*) continue ;; esac
        [ -e "$p" ] && { echo "$n"; return; }
    done
}

check() {
    nmcli networking connectivity check >/dev/null 2>&1 || true
}

up() {
    mode=${1:-form}
    case $mode in form|meraki) ;; *) echo "mode: form or meraki" >&2; exit 2 ;; esac
    wl=$(wifi_iface)
    [ -n "$wl" ] || { echo "no Wi-Fi interface" >&2; exit 1; }
    ip=$(ip -4 -o addr show dev "$wl" | awk '{print $4}' | cut -d/ -f1 | head -n1)
    [ -n "$ip" ] || { echo "$wl has no IPv4 address: connect to a network first" >&2; exit 1; }
    [ -f "$PIDFILE" ] && { echo "already up or signed in (down first)" >&2; exit 1; }
    python3 -I -c '
import http.server, subprocess, sys, urllib.parse
TABLE, MODE, BASE = sys.argv[3], sys.argv[4], "http://example.com/__t6-fake-portal/"
SPLASH = "http://example.com/splash/FAKE.1/"
MERAKI = """<html><head><title>Fake Meraki</title></head><body><h1>Welcome to Fake Hotel</h1>
<a class="button" href="%sgrant?continue_url=%s">Continue to the Internet</a></body></html>"""
PAGE = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Fake Hotel Wi-Fi</title>
<style>body{font:16px/1.4 sans-serif;margin:0;padding:32px 24px;color:#222;background:#fff}
h1{font-size:22px}input{font:inherit;width:100%%;box-sizing:border-box;padding:10px;margin:8px 0 16px}
button{font:inherit;width:100%%;padding:12px;background:#1a73e8;color:#fff;border:0;border-radius:6px}</style></head>
<body><h1>Fake Hotel Wi-Fi</h1><p>Welcome! Please accept the terms to get online.</p>
<form action="%sgrant" method="get"><input type="hidden" name="continue" value="%s">
<label>Room number (optional)<input name="room" autocomplete="off"></label>
<button type="submit">Connect</button></form></body></html>"""
class H(http.server.BaseHTTPRequestHandler):
    def reply(self, code, headers, body=b""):
        self.send_response(code)
        for k, v in headers: self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD": self.wfile.write(body)
    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        q = urllib.parse.parse_qs(url.query)
        back = q.get("continue", ["http://captive.apple.com/hotspot-detect.html"])[0]
        if MODE == "meraki":
            back = q.get("continue_url", ["http://captive.apple.com/hotspot-detect.html"])[0]
            if url.path == "/splash/FAKE.1/":
                page = MERAKI % (SPLASH, back.replace("/", "&#x2F;"))
                self.reply(200, [("Content-Type", "text/html; charset=utf-8"), ("Set-Cookie", "fake_session=1; Path=/")], page.encode())
            elif url.path == "/splash/FAKE.1/grant":
                if "fake_session=1" not in self.headers.get("Cookie", ""):
                    print("grant refused: no cookie", flush=True)
                    self.reply(403, [("Content-Type", "text/plain")], b"no session")
                    return
                subprocess.run(["nft", "delete", "table", "ip", TABLE], check=False)
                print("granted (meraki)", flush=True)
                self.reply(302, [("Location", back)])
            else:
                here = "http://" + self.headers.get("Host", "") + self.path
                self.reply(307, [("Location", SPLASH + "?continue_url=" + urllib.parse.quote(here, safe=""))])
        elif url.path == "/__t6-fake-portal/splash":
            page = PAGE % (BASE, back.replace(chr(34), "%22"))
            self.reply(200, [("Content-Type", "text/html; charset=utf-8")], page.encode())
        elif url.path == "/__t6-fake-portal/grant":
            subprocess.run(["nft", "delete", "table", "ip", TABLE], check=False)
            print("granted, room=" + q.get("room", [""])[0], flush=True)
            self.reply(302, [("Location", back)])
        else:
            here = "http://" + self.headers.get("Host", "") + self.path
            self.reply(302, [("Location", BASE + "splash?continue=" + urllib.parse.quote(here, safe=""))])
    do_HEAD = do_GET
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer((sys.argv[1], int(sys.argv[2])), H).serve_forever()
' "$ip" "$PORT" "$TABLE" "$mode" > /run/t6-fake-portal.log 2>&1 &
    echo $! > "$PIDFILE"
    nft -f - <<EOF
table ip $TABLE {
  chain out {
    type nat hook output priority -100;
    oifname "$wl" tcp dport 80 dnat to $ip:$PORT
  }
}
EOF
    check
    echo "up: port 80 out of $wl now goes to the fake portal (NetworkManager rechecks within seconds)"
}

down() {
    nft delete table ip "$TABLE" 2>/dev/null || true
    if [ -f "$PIDFILE" ]; then
        kill "$(cat "$PIDFILE")" 2>/dev/null || true
        rm -f "$PIDFILE"
    fi
    rm -f /run/t6-fake-portal.log
    check
    echo "down"
}

status() {
    wl=$(wifi_iface)
    echo "NetworkManager check: $(nmcli -g CONNECTIVITY general 2>/dev/null)"
    # connected Wi-Fi and wired devices (Docker's veths are "ethernet" too, but unmanaged)
    for d in $(nmcli -g DEVICE,TYPE,STATE device | awk -F: '($2=="wifi" || $2=="ethernet") && $3=="connected" {print $1}'); do
        echo "  $d: IPv4 $(nmcli -g GENERAL.IP4-CONNECTIVITY device show "$d") / IPv6 $(nmcli -g GENERAL.IP6-CONNECTIVITY device show "$d")"
    done
    echo "default routes:"
    ip route show default | sed 's/^/  /'
    if [ -r /run/t6-ledd/status.json ]; then
        echo "Wi-Fi LED: $(python3 -I -c 'import json; w = json.load(open("/run/t6-ledd/status.json"))["wifi"]; print(w["state"], "/", w["reason"])')"
    fi
    if nft list table ip "$TABLE" >/dev/null 2>&1; then echo "fake portal: up on ${wl:-?}"
    elif [ -f "$PIDFILE" ]; then echo "fake portal: signed in ($(tail -n1 /run/t6-fake-portal.log 2>/dev/null)); run down to clean up"
    else echo "fake portal: down"; fi
}

case "${1:-}" in
    up) up "${2:-}" ;;
    down) down ;;
    status) status ;;
    *) echo "usage: $0 up [form|meraki] | down | status" >&2; exit 2 ;;
esac
