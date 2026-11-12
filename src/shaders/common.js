export const fullscreenVertexShader = `#version 300 es
in vec2 aPosition;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

export const displayFragmentShader = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uAccum;
uniform vec2 uResolution;
uniform float uExposure;

out vec4 outColor;

vec3 aces(vec3 color) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((color * (a * color + b)) / (color * (c * color + d) + e), 0.0, 1.0);
}

float hash12(vec2 point) {
  vec3 p = fract(vec3(point.xyx) * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 sampleColor = texture(uAccum, uv);
  vec3 color = max(sampleColor.rgb, vec3(0.0));
  color *= exp2(uExposure);
  color = aces(color);
  color = pow(color, vec3(1.0 / 2.2));
  float aspect = uResolution.x / uResolution.y;
  float vignette = smoothstep(0.68, 1.3, length((uv - 0.5) * vec2(aspect, 1.0)));
  color *= 1.0 - vignette * 0.075;
  float dither = (hash12(gl_FragCoord.xy) - 0.5) * 0.003;
  color += dither;
  outColor = vec4(color, 1.0);
}
`;
