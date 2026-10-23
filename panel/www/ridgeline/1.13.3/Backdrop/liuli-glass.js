/* =====================================================================
   Ridgeline 1.13.0 — 长虹琉璃 (fluted glass) live backdrop.

   The page's own backdrop (the morning sky by day, the desk lamp at night)
   seen through a sheet of fluted glass. Wide flutes sit edge to edge, about
   29° off vertical, 60–135px wide and uneven. Behind the glass, soft blobs
   drift; each flute squeezes and shifts them differently, so the picture
   breaks at every seam, and a faint rainbow line runs along each seam.
   By day the glass shows in soft grey shadows; at night it catches the lamp.
   The colours underneath are exactly today's (tokens), only light and shade
   are added.

   Usage (one per screen, behind everything; see Backdrop README):

     <div class="rl-screen rl-backdrop--fixed has-glass">
       <canvas class="rl-glass-backdrop" aria-hidden="true"></canvas>
       …
     </div>

     const glass = RidgelineGlass.mount(document.querySelector('.rl-glass-backdrop'));
     glass.pause(); glass.resume();          // dimmed / off, control center, video player
     glass.refresh();                        // after the theme changes (also automatic: it watches
                                             // data-theme / class on <html> and on the nearest .rl-theme)
     glass.destroy();

   mount() returns null when WebGL2 is missing; the screen then keeps the CSS sky
   (remove .has-glass). Under prefers-reduced-motion it draws one still frame.
   ===================================================================== */
(function (global) {
  'use strict';

  var FPS = 20;            // the glass moves slowly; 20 frames a second is plenty
  var MAX_DPR = 2;         // never render more than 2 device pixels per CSS px
  var SPEED = 10;          // drift speed, in the units the preview used (×10 there)

  var VS = '#version 300 es\nin vec2 a; void main(){ gl_Position = vec4(a, 0., 1.); }';

  var FS = [
    '#version 300 es',
    'precision highp float;',
    'uniform vec2 uRes; uniform float uT, uDpr; uniform int uNight;',
    'uniform vec3 uSurface, uInk, uSky1, uSky2, uSky3; uniform float uSkyH;',
    'out vec4 o;',
    'vec3 h3(vec3 p){ p = fract(p*vec3(.1031,.1030,.0973)); p += dot(p, p.yxz+33.33); return fract((p.xxy+p.yxx)*p.zyx); }',
    'float vn(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);',
    '  float a=h3(i).x, b=h3(i+vec3(1,0,0)).x, c=h3(i+vec3(0,1,0)).x, d=h3(i+vec3(1,1,0)).x;',
    '  float e=h3(i+vec3(0,0,1)).x, f1=h3(i+vec3(1,0,1)).x, g=h3(i+vec3(0,1,1)).x, h=h3(i+vec3(1,1,1)).x;',
    '  return mix(mix(mix(a,b,f.x),mix(c,d,f.x),f.y), mix(mix(e,f1,f.x),mix(g,h,f.x),f.y), f.z); }',
    'float fbm(vec2 p, float t){ float s=0., a=.5; vec3 q=vec3(p,t); for(int i=0;i<4;i++){ s+=a*vn(q); q.xy=q.xy*2.03+vec2(17.1,9.2); q.z*=1.3; a*=.5; } return s/.9375; }',
    'mat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }',
    // what sits behind the glass
    'float blobs(vec2 p, float t){ float a = fbm(p/150., t*.020), b = fbm(p/70.+3.1, t*.028);',
    '  return clamp(smoothstep(.40,.72,a)*.8 + smoothstep(.50,.78,b)*.45, 0., 1.); }',
    'float pools(vec2 p, float t){ float v = fbm(p/260., t*.018); float l = smoothstep(.42,.80,v);',
    '  vec2 w = (p - vec2(250. + 60.*sin(t*.013), 40. + 30.*cos(t*.011)))/vec2(240.,200.);',
    '  return clamp(l*.75 + exp(-dot(w,w)*1.5)*.6, 0., 1.); }',
    // the page backdrop exactly as the CSS draws it (Backdrop › sky / lamp, .rl-silk)
    'vec4 radial(vec2 p, vec2 c, vec2 r, vec4 c0, float s1, vec4 c1, float s2){ float d = length((p-c)/r);',
    '  vec4 k = d < s1 ? mix(c0, c1, d/s1) : mix(c1, vec4(c1.rgb, 0.), clamp((d-s1)/(s2-s1), 0., 1.)); return k; }',
    'vec3 backdrop(vec2 p){',
    '  vec3 col = uSurface;',
    '  float wv = (mod(p.y, 3.) < 1. ? .015 : 0.) + (mod(p.x, 3.) < 1. ? .012 : 0.);   // silk weave',
    '  if (uNight == 0) {',
    '    float y = p.y/uSkyH; vec3 sky; float al;',
    '    if (y < .35) { sky = mix(uSky1, uSky2, y/.35); al = 1.; }',
    '    else if (y < .65) { sky = mix(uSky2, uSky3, (y-.35)/.30); al = 1.; }',
    '    else { sky = uSky3; al = 1. - clamp((y-.65)/.31, 0., 1.); }',
    '    col = mix(col, uInk, wv);',
    '    col = mix(col, sky, al);',
    '  } else {',
    '    col = mix(col, uInk, wv);',
    '    vec2 box = vec2(uRes.x/uDpr, uSkyH);',
    '    vec4 g2 = radial(p, vec2(box.x*.5, -box.y*.10), vec2(box.x, box.y*.70), vec4(1.,.804,.549,.10), .72, vec4(1.,.804,.549,0.), .72);',
    '    vec4 g1 = radial(p, vec2(box.x*.5, -box.y*.04), vec2(box.x*.58, box.y*.44), vec4(1.,.831,.588,.34), .42, vec4(1.,.784,.510,.14), .74);',
    '    col = mix(col, g2.rgb, g2.a); col = mix(col, g1.rgb, g1.a);',
    '  }',
    '  return col; }',
    'void main(){',
    '  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y)/uDpr;   // CSS px from the top left',
    '  float t = uT; bool night = uNight == 1;',
    '  vec3 base = backdrop(p);',
    '  mat2 R = rot(-.50), Ri = rot(.50);              // flutes about 29° off vertical',
    '  vec2 q = R*p; float W = 92.;',
    '  q.x += 10.*sin(q.y/300. + t*.021);              // hand-pressed: the flutes wander a little',
    '  float x0 = q.x/W;',
    '  float xw = x0 + .22*sin(x0*.71 + 1.3) + .14*sin(x0*1.37 + 4.1);        // uneven widths, ~60–135px',
    '  float dx = 1. + .22*.71*cos(x0*.71 + 1.3) + .14*1.37*cos(x0*1.37 + 4.1);',
    '  float Wl = W/dx; float id = floor(xw); float u = fract(xw) - .5;',
    '  vec3 rnd = h3(vec3(id, 1.7, 9.1));',
    '  float ctr = q.x - u*Wl;',
    '  float squeeze = mix(.22, .62, rnd.x);         // how much this flute narrows what is behind it',
    '  float shift = (rnd.y - .5)*Wl*1.6;            // where across it gathers it from',
    '  float slide = (rnd.z - .5)*140.;              // and how far along its length',
    '  vec3 F;',
    '  for (int c = 0; c < 3; c++) {',
    '    float dc = float(c-1)*.025*(1. + 2.*abs(u));  // dispersion grows toward the seams',
    '    float sx = ctr + shift + (u*squeeze + u*u*u*.9 + dc)*Wl;   // gentle in the middle, steep at the edges',
    '    vec2 bp = Ri*vec2(sx, q.y*.55 + slide);       // stretched along the flute',
    '    F[c] = night ? pools(bp, t)*.7 + blobs(bp, t)*.45 : blobs(bp, t);',
    '  }',
    '  float seam = smoothstep(.465, .5, abs(u));',
    '  vec3 irid = .5 + .5*cos(6.2832*(u*3. + rnd.x + vec3(0., .33, .67)));   // the rainbow line on each seam',
    '  vec3 col;',
    '  if (night) {',
    '    float lamp = .35 + .65*exp(-p.y/380.);          // the glass catches the lamp most near it',
    '    col = base + (vec3(1.,.80,.52) - base)*clamp(F*.36*lamp, 0., 1.);',
    '    col += irid*seam*.035;',
    '  } else {',
    '    col = base*(1. - F*.20);',
    '    col = col + (vec3(1.) - col)*clamp((1.-F.g)*.10*(1.-abs(u)*1.6), 0., 1.);',
    '    col = mix(col, col*(.92 + .16*irid), seam*.55);',
    '  }',
    '  col += (h3(vec3(gl_FragCoord.xy, 3.)).x - .5)/255.;   // grain, so nothing bands',
    '  o = vec4(col, 1.);',
    '}'
  ].join('\n');

  function rgb(css) {
    var m = /#([0-9a-f]{6})/i.exec(css || '');
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }
  function token(el, name, fallback) {
    return rgb(getComputedStyle(el).getPropertyValue(name)) || rgb(fallback);
  }

  function mount(canvas, opts) {
    opts = opts || {};
    var gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: false });
    if (!gl) return null;
    function sh(type, src) {
      var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    var prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog); gl.useProgram(prog);
    var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    var U = {};
    ['uRes', 'uT', 'uDpr', 'uNight', 'uSurface', 'uInk', 'uSky1', 'uSky2', 'uSky3', 'uSkyH'].forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });

    var reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Time is kept small: the shader gets it as a 32-bit float, which has fewer steps the larger it is
    // (handoff/panel-2.0 › 14: past ~2.4 days of uptime the drift would start to judder). The clock
    // starts again from the seconds into the hour on every resume, when the screen comes back from
    // dim or off, so nobody sees the jump; and at the latest past 2^20 (about 1.2 days of motion).
    var t0 = 0, offset = 0;
    function rebase() { t0 = performance.now(); offset = (Date.now() / 1000) % 3600; }
    rebase();
    var T_SOFT = 1048576, T_HARD = 4194304;    // 2^20: rebase at the next pause; 2^22 (~4.8 days): rebase now
    var paused = false, raf = 0, last = 0, dpr = 1, night = 0;

    function refresh() {
      var host = canvas.parentElement || canvas;
      night = opts.theme ? (opts.theme === 'dark' ? 1 : 0)
        : (host.closest('[data-theme="dark"], .rl-theme--dark') ? 1 : 0);
      gl.uniform1i(U.uNight, night);
      gl.uniform3fv(U.uSurface, token(host, '--surface-100', night ? '#1b1b1b' : '#f5f5f4'));
      gl.uniform3fv(U.uInk, token(host, '--ink', night ? '#e9e8e5' : '#1c211a'));
      gl.uniform3fv(U.uSky1, token(host, '--rl-sky-1', '#9fb4c6'));
      gl.uniform3fv(U.uSky2, token(host, '--rl-sky-2', '#c4d2dc'));
      gl.uniform3fv(U.uSky3, token(host, '--rl-sky-3', '#e6ebec'));
      gl.uniform1f(U.uSkyH, night ? 340 : 260);                     // --rl-backdrop-h
      draw(performance.now());
    }
    function size() {
      dpr = Math.min(global.devicePixelRatio || 1, MAX_DPR);
      var r = canvas.getBoundingClientRect();
      var w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    }
    function draw(now) {
      size();
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(U.uRes, canvas.width, canvas.height);
      gl.uniform1f(U.uDpr, dpr);
      var t = (offset + (now - t0) / 1000) * SPEED;
      if (t > T_HARD) { rebase(); t = offset * SPEED; }
      gl.uniform1f(U.uT, t);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    function loop(now) {
      raf = 0;
      if (paused || document.hidden) return;
      if (now - last >= 1000 / FPS) { last = now; draw(now); }
      raf = requestAnimationFrame(loop);
    }
    function start() { if (!reduce && !paused && !raf) raf = requestAnimationFrame(loop); }
    function onVis() { if (!document.hidden) { rebase(); start(); } }
    var ro = global.ResizeObserver ? new ResizeObserver(function () { draw(performance.now()); }) : null;
    if (ro) ro.observe(canvas);
    document.addEventListener('visibilitychange', onVis);

    // follow theme changes on the root or the nearest .rl-theme by itself (refresh() still works)
    var host0 = canvas.parentElement || canvas, themeEl = host0.closest('.rl-theme');
    var mo = global.MutationObserver ? new MutationObserver(function () { refresh(); }) : null;
    if (mo) {
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
      if (themeEl) mo.observe(themeEl, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    }

    refresh(); start();
    return {
      pause: function () { paused = true; if (raf) { cancelAnimationFrame(raf); raf = 0; } },
      resume: function () { paused = false; rebase(); start(); },
      refresh: refresh,
      destroy: function () {
        this.pause(); if (ro) ro.disconnect(); if (mo) mo.disconnect(); document.removeEventListener('visibilitychange', onVis);
        gl.deleteProgram(prog); gl.deleteBuffer(buf);
      }
    };
  }

  global.RidgelineGlass = { mount: mount, version: '1.13.2' };
})(typeof window !== 'undefined' ? window : this);
