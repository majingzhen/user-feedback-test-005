export const MATERIAL_KEYS = ["metal", "glass", "floor", "light"];
export const MATERIAL_INDEX = { floor: 0, metal: 1, glass: 2, light: 3 };

export const RESOLUTIONS = [
  { id: "960x540", width: 960, height: 540, label: "960 × 540" },
  { id: "1280x720", width: 1280, height: 720, label: "1280 × 720" },
  { id: "1600x900", width: 1600, height: 900, label: "1600 × 900" },
];

export const MATERIAL_DEFAULTS = {
  metal: { color: "#c8a87a", roughness: 0.16 },
  glass: { color: "#ffffff", ior: 1.52 },
  floor: { color: "#9c978f" },
  light: { color: "#fff0da", intensity: 7.2, width: 2.8, height: 1.4, elevation: 4.2 },
};

export const DEFAULT_STATE = {
  version: 1,
  camera: {
    yaw: 0,
    pitch: 0.2,
    dist: 6.8,
    target: [0, 1.02, 0],
  },
  materials: {
    metal: { ...MATERIAL_DEFAULTS.metal },
    glass: { ...MATERIAL_DEFAULTS.glass },
    floor: { ...MATERIAL_DEFAULTS.floor },
    light: { ...MATERIAL_DEFAULTS.light },
  },
  locks: {
    metal: false,
    glass: false,
    floor: false,
    light: false,
  },
  render: {
    samplesPerFrame: 2,
    maxBounces: 6,
    exposure: 0,
    resolution: "960x540",
    historyReprojection: true,
  },
};

export const MATERIAL_META = {
  metal: { name: "金属球", sub: "粗糙导体 · GGX 反射", icon: "sphere" },
  glass: { name: "玻璃球", sub: "电介质 · 菲涅尔折射", icon: "glass" },
  floor: { name: "漫反射地面", sub: "Lambertian · 软阴影", icon: "floor" },
  light: { name: "面光源", sub: "面积采样 · 焦散光源", icon: "light" },
};

export const ENVIRONMENT = {
  horizon: [0.028, 0.032, 0.038],
  zenith: [0.075, 0.09, 0.115],
  glow: [0.055, 0.04, 0.022],
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const asNumber = (value, fallback) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fallback;
};

const clone = (value) => JSON.parse(JSON.stringify(value));

export const makeDefaultState = () => clone(DEFAULT_STATE);

export const hydrateState = (raw) => {
  const base = makeDefaultState();
  if (!raw || typeof raw !== "object" || raw.version !== 1) return base;

  const camera = raw.camera && typeof raw.camera === "object" ? raw.camera : {};
  base.camera.yaw = asNumber(camera.yaw, base.camera.yaw);
  base.camera.pitch = clamp(asNumber(camera.pitch, base.camera.pitch), 0.02, 1.15);
  base.camera.dist = clamp(asNumber(camera.dist, base.camera.dist), 3.2, 12.5);
  if (Array.isArray(camera.target) && camera.target.length === 3 && camera.target.every(Number.isFinite)) {
    base.camera.target = camera.target.map(Number);
  }

  const materials = raw.materials && typeof raw.materials === "object" ? raw.materials : {};
  for (const key of MATERIAL_KEYS) {
    const source = materials[key];
    if (!source || typeof source !== "object") continue;
    for (const prop of Object.keys(base.materials[key])) {
      const current = base.materials[key][prop];
      if (typeof current === "string") {
        if (typeof source[prop] === "string" && /^#[0-9a-f]{6}$/i.test(source[prop])) {
          base.materials[key][prop] = source[prop];
        }
      } else {
        const next = asNumber(source[prop], current);
        base.materials[key][prop] = Math.max(0.01, next);
      }
    }
  }

  const locks = raw.locks && typeof raw.locks === "object" ? raw.locks : {};
  for (const key of MATERIAL_KEYS) base.locks[key] = Boolean(locks[key]);

  const render = raw.render && typeof raw.render === "object" ? raw.render : {};
  const spp = asNumber(render.samplesPerFrame, base.render.samplesPerFrame);
  base.render.samplesPerFrame = [1, 2, 4, 8].includes(spp) ? spp : base.render.samplesPerFrame;
  base.render.maxBounces = Math.round(clamp(asNumber(render.maxBounces, base.render.maxBounces), 3, 12));
  base.render.exposure = clamp(asNumber(render.exposure, base.render.exposure), -2.5, 2.5);
  if (RESOLUTIONS.some((item) => item.id === render.resolution)) base.render.resolution = render.resolution;
  base.render.historyReprojection = render.historyReprojection !== false;

  if (base.materials.glass.ior > 2.4 || base.materials.glass.ior < 1.05) {
    base.materials.glass.ior = MATERIAL_DEFAULTS.glass.ior;
  }
  if (base.materials.metal.roughness > 0.8) base.materials.metal.roughness = 0.8;
  if (base.materials.light.width > 6 || base.materials.light.width < 1) {
    base.materials.light.width = MATERIAL_DEFAULTS.light.width;
  }
  if (base.materials.light.height > 4 || base.materials.light.height < 0.6) {
    base.materials.light.height = MATERIAL_DEFAULTS.light.height;
  }
  base.materials.light.elevation = clamp(
    asNumber(base.materials.light.elevation, MATERIAL_DEFAULTS.light.elevation),
    2.4,
    6
  );
  return base;
};

export const clampCamera = (camera) => ({
  yaw: asNumber(camera.yaw, 0),
  pitch: clamp(asNumber(camera.pitch, 0.2), 0.02, 1.15),
  dist: clamp(asNumber(camera.dist, 6.8), 3.2, 12.5),
  target: camera.target,
});

export const cameraBasis = (camera) => {
  const { yaw, pitch, dist, target } = camera;
  const cp = Math.cos(pitch);
  const position = [
    target[0] + dist * Math.sin(yaw) * cp,
    target[1] + dist * Math.sin(pitch),
    target[2] + dist * Math.cos(yaw) * cp,
  ];
  const forward = normalize([target[0] - position[0], target[1] - position[1], target[2] - position[2]]);
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = normalize(cross(right, forward));
  return { position, forward, right, up };
};

export const buildLight = (state) => {
  const light = state.materials.light;
  const center = [0.45, light.elevation, 0.65];
  const u = [light.width, 0, 0];
  const v = [0, 0, light.height];
  const corner = [center[0] - u[0] / 2, center[1], center[2] - v[2] / 2];
  return {
    center,
    corner,
    u,
    v,
    normal: [0, -1, 0],
    area: light.width * light.height,
    emission: hexToLinear(light.color).map((channel) => channel * light.intensity),
  };
};

export const buildPrimitives = (state) => {
  const light = buildLight(state);
  return [
    {
      type: "quad",
      corner: [-30, 0, -30],
      u: [0, 0, 60],
      v: [60, 0, 0],
      material: MATERIAL_INDEX.floor,
    },
    {
      type: "sphere",
      center: [-1.35, 0.85, 0.18],
      radius: 0.85,
      material: MATERIAL_INDEX.metal,
    },
    {
      type: "sphere",
      center: [1.3, 1.35, 0.15],
      radius: 0.9,
      material: MATERIAL_INDEX.glass,
    },
    {
      type: "quad",
      corner: light.corner,
      u: light.u,
      v: light.v,
      material: MATERIAL_INDEX.light,
      light: true,
    },
  ];
};

export const buildMaterials = (state) => {
  const light = buildLight(state);
  return [
    {
      type: 0,
      albedo: hexToLinear(state.materials.floor.color),
      roughness: 1,
      ior: 1,
      emission: [0, 0, 0],
    },
    {
      type: 1,
      albedo: hexToLinear(state.materials.metal.color),
      roughness: state.materials.metal.roughness,
      ior: 1,
      emission: [0, 0, 0],
    },
    {
      type: 2,
      albedo: hexToLinear(state.materials.glass.color),
      roughness: 0.01,
      ior: state.materials.glass.ior,
      emission: [0, 0, 0],
    },
    {
      type: 3,
      albedo: [0, 0, 0],
      roughness: 1,
      ior: 1,
      emission: light.emission,
    },
  ];
};

export const sceneSignature = (state) => {
  const resolution = RESOLUTIONS.find((item) => item.id === state.render.resolution);
  const raw = JSON.stringify({
    m: state.materials,
    b: state.render.maxBounces,
    r: [resolution.width, resolution.height],
  });
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `v1-${resolution.width}x${resolution.height}-${(hash >>> 0).toString(16)}`;
};

export const resetUnlockedMaterials = (state) => {
  const next = clone(state);
  for (const key of MATERIAL_KEYS) {
    if (!next.locks[key]) next.materials[key] = { ...MATERIAL_DEFAULTS[key] };
  }
  return next;
};

export const resolutionInfo = (state) => {
  const item = RESOLUTIONS.find((entry) => entry.id === state.render.resolution);
  return item;
};

export const serializeState = (state) => JSON.stringify(state);

export const hexToLinear = (hex) => {
  const clean = hex.replace("#", "");
  const rgb = [0, 2, 4].map((offset) => parseInt(clean.slice(offset, offset + 2), 16) / 255);
  return rgb.map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
};

function normalize(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
