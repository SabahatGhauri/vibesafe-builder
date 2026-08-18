"use strict";
/* The homepage hero crystal — a real-time WebGPU render of the brand mark
   (◆) extruded into a faceted gem, slowly rotating with cursor-driven tilt.
   Zero dependencies, hand-written WGSL: this is one focused scene, not a
   general 3D toolkit, so pulling in a full engine would add weight for
   nothing this page needs elsewhere.

   FALLBACK POLICY — the existing #heroCards float-card treatment (untouched,
   see landing.html) stays the fallback for:
     - browsers without WebGPU (notably Firefox, still opt-in as of mid-2026)
     - prefers-reduced-motion
     - small/mobile viewports (a 3D crystal fighting a 380px hero on a phone
       is worse than the simpler card treatment, not better)
     - WebGPU present but adapter/device/pipeline creation fails for any
       reason (driver issues, disabled flags, etc.)
   The swap only happens ONE way, and only once the WebGPU path has fully
   proven itself: the canvas stays hidden and the cards stay visible until a
   frame has actually rendered without error. A half-initialized WebGPU path
   must never leave the hero blank. */

async function initHero3D() {
  const canvas = document.getElementById("heroCrystal");
  const fallback = document.getElementById("heroFallback");
  if (!canvas || !fallback) return;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isSmallViewport = window.innerWidth < 760; // matches the existing .hero-3d mobile breakpoint
  if (!navigator.gpu || reducedMotion || isSmallViewport) return; // fallback cards stay as they are

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("no WebGPU adapter available");
    const device = await adapter.requestDevice();
    device.lost.then((info) => console.warn("WebGPU device lost:", info.message));

    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("canvas has no webgpu context");
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "premultiplied" });

    const renderer = buildRenderer(device, context, format, canvas);
    renderer.renderFrame(0); // prove it actually works before touching the DOM

    canvas.hidden = false;
    fallback.hidden = true;
    startLoop(renderer, canvas);
  } catch (err) {
    // Never leave a half-broken state — canvas stays hidden, cards untouched.
    console.warn("Hero crystal unavailable, showing the card fallback instead:", err);
  }
}

/* ---------------- geometry: the brand mark, extruded ---------------- */
// The logo path is M32 10 L50 32 L32 54 L14 32 — a rhombus centered on
// (32,32), 22 tall / 18 wide from center. Reused here as a belt ring with a
// front and back apex, making a bipyramid: exactly "extrude the 2D mark into
// a 3D gem," not a generic diamond shape invented separately from the brand.
function buildGeometry() {
  const top = [0, 1.0, 0];
  const right = [0.82, 0, 0];
  const bottom = [0, -1.0, 0];
  const left = [-0.82, 0, 0];
  const front = [0, 0, 1.15];
  const back = [0, 0, -0.85]; // shorter than the front apex — reads as a cut gem, not a symmetric octahedron

  // Each face lists its 3 corners in a WINDING ORDER that faces outward
  // (counter-clockwise as seen from outside), so backface culling can be used
  // instead of a depth buffer — the shape is convex, so cull-only is correct
  // and one less thing (a depth texture) to configure and get wrong.
  const faces = [
    [front, top, right],
    [front, right, bottom],
    [front, bottom, left],
    [front, left, top],
    [back, right, top],
    [back, bottom, right],
    [back, left, bottom],
    [back, top, left],
  ];

  // Brand palette (see :root in landing.html) cycled per facet, so the gem
  // reads as multi-color and jewel-like rather than one flat tint.
  const PALETTE = [
    [0.208, 0.851, 0.604], // --accent  #35d99a
    [0.310, 0.765, 1.0], //   --accent2 #4fc3ff
    [0.941, 0.722, 0.306], // --warn    #f0b84e
  ];

  // Non-indexed, one normal per face (flat shading = the faceted look) —
  // vertices are deliberately duplicated per face rather than shared, since a
  // shared-vertex/smooth-normal mesh would render as a rounded blob, not cut
  // facets.
  const verts = [];
  faces.forEach((face, i) => {
    const [a, b, c] = face;
    const n = faceNormal(a, b, c);
    const color = PALETTE[i % PALETTE.length];
    for (const p of [a, b, c]) verts.push(...p, ...n, ...color);
  });
  return new Float32Array(verts);
}

function faceNormal(a, b, c) {
  const u = sub(b, a);
  const v = sub(c, a);
  return normalize(cross(u, v));
}

/* ---------------- tiny vec/mat helpers (no external math library) ---------------- */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function mat4Multiply(a, b) {
  const out = new Float32Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}
function mat4Perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = far / (near - far);
  out[11] = -1;
  out[14] = (far * near) / (near - far);
  return out;
}
function mat4LookAt(eye, center, up) {
  const z = normalize(sub(eye, center));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  const out = new Float32Array(16);
  out[0] = x[0]; out[4] = x[1]; out[8] = x[2]; out[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]);
  out[1] = y[0]; out[5] = y[1]; out[9] = y[2]; out[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]);
  out[2] = z[0]; out[6] = z[1]; out[10] = z[2]; out[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]);
  out[15] = 1;
  return out;
}
function mat4RotationXY(rx, ry) {
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry);
  // rotateY then rotateX, combined
  const ry4 = new Float32Array([cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1]);
  const rx4 = new Float32Array([1, 0, 0, 0, 0, cx, sx, 0, 0, -sx, cx, 0, 0, 0, 0, 1]);
  return mat4Multiply(rx4, ry4);
}

/* ---------------- WGSL ---------------- */
const SHADER = /* wgsl */ `
struct Uniforms {
  model : mat4x4<f32>,
  viewProj : mat4x4<f32>,
  cameraPos : vec4<f32>,
  lightDir : vec4<f32>,
};
@group(0) @binding(0) var<uniform> u : Uniforms;

struct VertexIn {
  @location(0) position : vec3<f32>,
  @location(1) normal : vec3<f32>,
  @location(2) color : vec3<f32>,
};
struct VertexOut {
  @builtin(position) clipPosition : vec4<f32>,
  @location(0) worldPos : vec3<f32>,
  @location(1) normal : vec3<f32>,
  @location(2) color : vec3<f32>,
};

@vertex
fn vs_main(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  let world = u.model * vec4<f32>(input.position, 1.0);
  out.worldPos = world.xyz;
  out.clipPosition = u.viewProj * world;
  out.normal = normalize((u.model * vec4<f32>(input.normal, 0.0)).xyz);
  out.color = input.color;
  return out;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4<f32> {
  let N = normalize(input.normal);
  let V = normalize(u.cameraPos.xyz - input.worldPos);
  let L = normalize(u.lightDir.xyz);
  let H = normalize(L + V);

  let diffuse = max(dot(N, L), 0.0);
  let spec = pow(max(dot(N, H), 0.0), 48.0);
  let fresnel = pow(1.0 - max(dot(N, V), 0.0), 2.5);

  let ambient = vec3<f32>(0.05, 0.06, 0.065);
  var col = ambient * input.color + input.color * diffuse * 0.85 + vec3<f32>(1.0, 1.0, 1.0) * spec * 0.9;
  col = col + vec3<f32>(0.55, 0.92, 0.82) * fresnel * 0.55; // teal rim glow, ties to --accent
  return vec4<f32>(col, 1.0);
}
`;

/* ---------------- renderer setup ---------------- */
function buildRenderer(device, context, format, canvas) {
  const geometry = buildGeometry();
  const vertexBuffer = device.createBuffer({
    size: geometry.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, geometry);
  const vertexCount = geometry.length / 9; // position(3) + normal(3) + color(3)

  const uniformBuffer = device.createBuffer({
    size: 4 * 16 * 2 + 16 + 16, // model + viewProj + cameraPos + lightDir
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const module = device.createShaderModule({ code: SHADER });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module,
      entryPoint: "vs_main",
      buffers: [
        {
          arrayStride: 9 * 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x3" },
          ],
        },
      ],
    },
    fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
    primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  // Mouse-driven tilt, same (pointer: fine) gate the existing card parallax
  // uses — no point adding a hover interaction a touch device can't perform.
  let targetTiltX = 0;
  let targetTiltY = 0;
  if (window.matchMedia("(pointer: fine)").matches) {
    const heroArea = canvas.closest(".hero-3d") || canvas.parentElement;
    heroArea?.addEventListener("mousemove", (e) => {
      const r = heroArea.getBoundingClientRect();
      targetTiltY = ((e.clientX - r.left) / r.width - 0.5) * 0.6;
      targetTiltX = -((e.clientY - r.top) / r.height - 0.5) * 0.6;
    });
    heroArea?.addEventListener("mouseleave", () => {
      targetTiltX = 0;
      targetTiltY = 0;
    });
  }
  let tiltX = 0;
  let tiltY = 0;

  function currentAspect() {
    return canvas.width / canvas.height || 1;
  }

  function renderFrame(t) {
    const seconds = t / 1000;
    tiltX += (targetTiltX - tiltX) * 0.08;
    tiltY += (targetTiltY - tiltY) * 0.08;

    const model = mat4RotationXY(0.3 + tiltX, seconds * 0.35 + tiltY);
    const view = mat4LookAt([0, 0, 3.4], [0, 0, 0], [0, 1, 0]);
    const proj = mat4Perspective((38 * Math.PI) / 180, currentAspect(), 0.1, 10);
    const viewProj = mat4Multiply(proj, view);

    // model(16) + viewProj(16) + cameraPos(4) + lightDir(4) = 40 floats = 160
    // bytes, matching the buffer allocated below. An earlier version of this
    // used the wrong count (72 floats into a 160-byte buffer) and WebGPU
    // correctly refused the write — caught only by actually running this in a
    // browser, not by reading the code.
    const uniformData = new Float32Array(40);
    uniformData.set(model, 0);
    uniformData.set(viewProj, 16);
    uniformData.set([0, 0, 3.4, 0], 32);
    uniformData.set([0.4, 0.7, 0.6, 0], 36);
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 }, // transparent — the page background shows through
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.setBindGroup(0, bindGroup);
    pass.draw(vertexCount);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2); // cap DPR — a 3-4x phone/retina buffer costs real GPU time for no visible gain
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
  }

  return { renderFrame, resize };
}

function startLoop(renderer, canvas) {
  renderer.resize();
  const ro = new ResizeObserver(() => renderer.resize());
  ro.observe(canvas);

  let running = true;
  document.addEventListener("visibilitychange", () => {
    running = document.visibilityState === "visible";
    if (running) requestAnimationFrame(loop);
  });

  function loop(t) {
    if (!running) return;
    renderer.renderFrame(t);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initHero3D);
} else {
  initHero3D();
}
