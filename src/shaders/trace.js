export const pathTracerFragmentShader = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

const int MAX_PRIMS = 8;
const int MAX_NODES = 16;
const int MAX_MATERIALS = 4;
const float PI = 3.14159265359;
const float EPS = 0.001;
const float FAR = 1.0e20;

uniform vec2 uResolution;
uniform uint uSeed;
uniform int uSamplesPerFrame;
uniform int uMaxBounces;
uniform int uHistoryMode;
uniform float uHistoryRetain;
uniform sampler2D uPrevAccum;
uniform sampler2D uPrevPosition;

uniform vec3 uCameraPosition;
uniform vec3 uCameraRight;
uniform vec3 uCameraUp;
uniform vec3 uCameraForward;
uniform float uTanHalfFov;
uniform float uAspect;

uniform vec3 uPrevCameraPosition;
uniform vec3 uPrevCameraRight;
uniform vec3 uPrevCameraUp;
uniform vec3 uPrevCameraForward;
uniform float uPrevTanHalfFov;
uniform float uPrevAspect;

uniform int uPrimCount;
uniform int uNodeCount;
uniform vec4 uPrimA[MAX_PRIMS];
uniform vec4 uPrimB[MAX_PRIMS];
uniform vec4 uPrimC[MAX_PRIMS];
uniform vec4 uPrimD[MAX_PRIMS];
uniform vec4 uNodeMin[MAX_NODES];
uniform vec4 uNodeMax[MAX_NODES];
uniform ivec4 uNodeMeta[MAX_NODES];
uniform int uPrimIndices[MAX_PRIMS];

uniform vec4 uMaterialA[MAX_MATERIALS];
uniform vec4 uMaterialB[MAX_MATERIALS];
uniform vec4 uMaterialEmission[MAX_MATERIALS];

uniform vec3 uLightCorner;
uniform vec3 uLightU;
uniform vec3 uLightV;
uniform vec3 uLightNormal;
uniform vec3 uLightEmission;
uniform float uLightArea;

uniform vec3 uEnvHorizon;
uniform vec3 uEnvZenith;
uniform vec3 uEnvGlow;

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outPosition;

struct Hit {
  float t;
  vec3 position;
  vec3 normal;
  vec3 geometryNormal;
  int material;
  int primitive;
};

struct Ray {
  vec3 origin;
  vec3 direction;
};

uint pcg(uint value) {
  uint state = value * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

float randomFloat(inout uint state) {
  state = pcg(state);
  return float(state >> 8u) * (1.0 / 16777216.0);
}

vec3 cosineHemisphere(vec3 normal, inout uint state) {
  float u1 = randomFloat(state);
  float u2 = randomFloat(state);
  float radius = sqrt(u1);
  float phi = 2.0 * PI * u2;
  vec3 helper = abs(normal.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 tangent = normalize(cross(helper, normal));
  vec3 bitangent = cross(normal, tangent);
  return normalize(tangent * (radius * cos(phi)) + bitangent * (radius * sin(phi)) + normal * sqrt(max(0.0, 1.0 - u1)));
}

vec3 sampleGGX(vec3 incoming, vec3 normal, float roughness, inout uint state) {
  float alpha = max(roughness * roughness, 0.0004);
  float u1 = randomFloat(state);
  float u2 = randomFloat(state);
  float phi = 2.0 * PI * u1;
  float cosTheta = sqrt(max(0.0, (1.0 - u2) / (1.0 + (alpha * alpha - 1.0) * u2)));
  float sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
  vec3 helper = abs(normal.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 tangent = normalize(cross(helper, normal));
  vec3 bitangent = cross(normal, tangent);
  vec3 halfway = normalize(tangent * (sinTheta * cos(phi)) + bitangent * (sinTheta * sin(phi)) + normal * cosTheta);
  vec3 outgoing = reflect(incoming, halfway);
  if (dot(outgoing, normal) <= 0.0) outgoing = reflect(incoming, normal);
  return normalize(outgoing);
}

float fresnelSchlick(float cosTheta, float n1, float n2) {
  float ratio = (n1 - n2) / (n1 + n2);
  float f0 = ratio * ratio;
  float f = f0 + (1.0 - f0) * pow(1.0 - clamp(cosTheta, 0.0, 1.0), 5.0);
  return clamp(f, 0.0, 1.0);
}

vec3 environmentRadiance(vec3 direction) {
  float t = clamp(direction.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 sky = mix(uEnvHorizon, uEnvZenith, smoothstep(0.12, 0.88, t));
  float glow = pow(max(dot(direction, normalize(vec3(-0.45, 0.62, 0.64))), 0.0), 10.0);
  sky += uEnvGlow * glow * 0.55;
  float floorFalloff = smoothstep(0.0, -0.2, direction.y);
  return sky * (1.0 - floorFalloff * 0.6);
}

bool intersectSphere(vec3 center, float radius, vec3 origin, vec3 direction, float tMin, float tMax, out float t, out vec3 normal) {
  vec3 oc = origin - center;
  float b = dot(oc, direction);
  float c = dot(oc, oc) - radius * radius;
  float discriminator = b * b - c;
  if (discriminator < 0.0) return false;
  float root = sqrt(discriminator);
  float first = -b - root;
  float second = -b + root;
  float chosen = first;
  if (chosen < tMin) chosen = second;
  if (chosen < tMin || chosen > tMax) return false;
  t = chosen;
  normal = normalize(origin + direction * chosen - center);
  return true;
}

bool intersectQuad(vec3 corner, vec3 edgeU, vec3 edgeV, vec3 origin, vec3 direction, float tMin, float tMax, out float t, out vec3 normal) {
  vec3 faceNormal = normalize(cross(edgeU, edgeV));
  float denominator = dot(direction, faceNormal);
  if (abs(denominator) < 1.0e-8) return false;
  float candidate = dot(corner - origin, faceNormal) / denominator;
  if (candidate < tMin || candidate > tMax) return false;
  vec3 point = origin + direction * candidate;
  vec3 relative = point - corner;
  float su = dot(relative, edgeU) / dot(edgeU, edgeU);
  float sv = dot(relative, edgeV) / dot(edgeV, edgeV);
  if (su < 0.0 || su > 1.0 || sv < 0.0 || sv > 1.0) return false;
  t = candidate;
  normal = faceNormal;
  return true;
}

bool hitPrimitive(int index, vec3 origin, vec3 direction, float tMin, float tMax, out Hit hit) {
  vec4 primitiveA = uPrimA[index];
  vec4 primitiveD = uPrimD[index];
  float primitiveType = primitiveD.y;
  float t;
  vec3 normal;
  if (primitiveType < 0.5) {
    if (!intersectSphere(primitiveA.xyz, primitiveA.w, origin, direction, tMin, tMax, t, normal)) return false;
  } else {
    if (!intersectQuad(primitiveA.xyz, uPrimB[index].xyz, uPrimC[index].xyz, origin, direction, tMin, tMax, t, normal)) return false;
  }
  hit.t = t;
  hit.position = origin + direction * t;
  hit.normal = normal;
  hit.geometryNormal = normal;
  hit.material = int(primitiveD.x);
  hit.primitive = index;
  return true;
}

bool traceScene(vec3 origin, vec3 direction, float tMin, float tMax, out Hit result) {
  result.t = -1.0;
  if (uPrimCount <= 0) return false;
  float closest = tMax;
  int stack[32];
  int stackSize = 0;
  stack[stackSize++] = 0;
  vec3 inverseDirection = 1.0 / (direction + vec3(1.0e-9));
  while (stackSize > 0) {
    int nodeIndex = stack[--stackSize];
    vec3 boundsMin = uNodeMin[nodeIndex].xyz;
    vec3 boundsMax = uNodeMax[nodeIndex].xyz;
    vec3 t0 = (boundsMin - origin) * inverseDirection;
    vec3 t1 = (boundsMax - origin) * inverseDirection;
    vec3 nearPlane = min(t0, t1);
    vec3 farPlane = max(t0, t1);
    float near = max(max(nearPlane.x, nearPlane.y), nearPlane.z);
    float far = min(min(farPlane.x, farPlane.y), farPlane.z);
    if (far < max(near, tMin) || near > closest) continue;
    ivec4 meta = uNodeMeta[nodeIndex];
    if (meta.w > 0) {
      for (int index = 0; index < meta.w; index++) {
        int primitiveIndex = uPrimIndices[meta.z + index];
        Hit candidate;
        if (hitPrimitive(primitiveIndex, origin, direction, tMin, closest, candidate)) {
          closest = candidate.t;
          result = candidate;
        }
      }
    } else {
      stack[stackSize++] = meta.x;
      stack[stackSize++] = meta.y;
    }
  }
  return result.t >= 0.0;
}

vec3 directLighting(vec3 position, vec3 normal, vec3 albedo, inout uint state) {
  vec3 lightPoint = uLightCorner + uLightU * randomFloat(state) + uLightV * randomFloat(state);
  vec3 toLight = lightPoint - position;
  float distanceSquared = dot(toLight, toLight);
  float distanceToLight = sqrt(distanceSquared);
  vec3 wi = toLight / distanceToLight;
  float cosSurface = dot(normal, wi);
  float cosLight = dot(uLightNormal, -wi);
  if (cosSurface <= 0.0 || cosLight <= 0.0) return vec3(0.0);
  float limit = distanceToLight - 2.0 * EPS;
  if (limit <= EPS) return vec3(0.0);
  Hit shadowHit;
  if (traceScene(position + normal * EPS, wi, EPS, limit, shadowHit)) return vec3(0.0);
  float geometric = cosSurface * cosLight * uLightArea / distanceSquared;
  return albedo * (geometric / PI) * uLightEmission;
}

vec3 cameraDirection(vec2 uv) {
  vec2 ndc = uv * 2.0 - 1.0;
  return normalize(uCameraForward + uCameraRight * (ndc.x * uTanHalfFov * uAspect) + uCameraUp * (ndc.y * uTanHalfFov));
}

vec3 tracePath(vec3 start, vec3 direction, inout uint state) {
  vec3 radiance = vec3(0.0);
  vec3 throughput = vec3(1.0);
  vec3 origin = start;
  vec3 rayDirection = direction;
  bool previousSpecular = true;

  for (int bounce = 0; bounce < uMaxBounces; bounce++) {
    Hit hit;
    if (!traceScene(origin, rayDirection, EPS, FAR, hit)) {
      radiance += throughput * environmentRadiance(rayDirection);
      break;
    }

    if (hit.material == 3) {
      if (dot(rayDirection, hit.geometryNormal) < 0.0 && (bounce == 0 || previousSpecular)) {
        radiance += throughput * uMaterialEmission[3].rgb;
      }
      break;
    }

    vec3 normal = hit.geometryNormal;
    if (dot(rayDirection, normal) > 0.0) normal = -normal;
    int material = hit.material;
    vec3 albedo = uMaterialA[material].rgb;

    if (material == 0) {
      radiance += throughput * directLighting(hit.position, normal, albedo, state);
      vec3 outgoing = cosineHemisphere(normal, state);
      if (dot(outgoing, normal) <= 0.0) outgoing = normal;
      throughput *= albedo;
      origin = hit.position + normal * EPS;
      rayDirection = outgoing;
      previousSpecular = false;
    } else if (material == 1) {
      float roughness = uMaterialB[material].x;
      vec3 outgoing = sampleGGX(rayDirection, normal, roughness, state);
      float cosView = clamp(dot(-rayDirection, normal), 0.0, 1.0);
      vec3 fresnel = albedo + (1.0 - albedo) * pow(1.0 - cosView, 5.0);
      throughput *= fresnel;
      origin = hit.position + normal * EPS;
      rayDirection = outgoing;
      previousSpecular = true;
    } else {
      vec3 outward = hit.geometryNormal;
      bool entering = dot(rayDirection, outward) < 0.0;
      vec3 faceNormal = entering ? outward : -outward;
      float cosIncident = clamp(dot(-rayDirection, faceNormal), 0.0, 1.0);
      float n1 = entering ? 1.0 : uMaterialB[material].y;
      float n2 = entering ? uMaterialB[material].y : 1.0;
      float reflectance = fresnelSchlick(cosIncident, n1, n2);
      if (randomFloat(state) < reflectance) {
        rayDirection = normalize(reflect(rayDirection, faceNormal));
        throughput *= vec3(0.98);
      } else {
        vec3 refracted = refract(rayDirection, faceNormal, n1 / n2);
        if (dot(refracted, refracted) < 1.0e-7) {
          rayDirection = normalize(reflect(rayDirection, faceNormal));
        } else {
          rayDirection = normalize(refracted);
          throughput *= albedo;
        }
      }
      origin = hit.position + rayDirection * EPS;
      previousSpecular = true;
    }

    if (max(max(throughput.r, throughput.g), throughput.b) < 1.0e-4) break;
  }

  return clamp(radiance, vec3(0.0), vec3(64.0));
}

void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  vec2 pixelUv = gl_FragCoord.xy / uResolution;

  vec3 primaryPosition = vec3(0.0);
  float primaryValid = 0.0;
  Hit primaryHit;
  vec3 centerDirection = cameraDirection(pixelUv);
  if (traceScene(uCameraPosition, centerDirection, 0.0, FAR, primaryHit)) {
    primaryPosition = primaryHit.position;
    primaryValid = 1.0;
  }

  float historyCount = 0.0;
  vec3 historyColor = vec3(0.0);
  if (uHistoryMode == 1) {
    vec4 previous = texelFetch(uPrevAccum, pixel, 0);
    historyCount = previous.a * uHistoryRetain;
    historyColor = previous.rgb;
  } else if (uHistoryMode == 2 && primaryValid > 0.5) {
    vec3 relative = primaryPosition - uPrevCameraPosition;
    float depth = dot(relative, uPrevCameraForward);
    if (depth > 0.05) {
      float ndcX = dot(relative, uPrevCameraRight) / (depth * uPrevTanHalfFov * uPrevAspect);
      float ndcY = dot(relative, uPrevCameraUp) / (depth * uPrevTanHalfFov);
      vec2 previousUv = vec2(ndcX, ndcY) * 0.5 + 0.5;
      if (previousUv.x > 0.0 && previousUv.y > 0.0 && previousUv.x < 1.0 && previousUv.y < 1.0) {
        ivec2 previousPixel = clamp(ivec2(previousUv * uResolution), ivec2(0), ivec2(uResolution) - 1);
        vec4 previousPosition = texelFetch(uPrevPosition, previousPixel, 0);
        if (previousPosition.w > 0.5) {
          float tolerance = 0.03 + 0.01 * length(previousPosition.xyz);
          if (distance(previousPosition.xyz, primaryPosition) <= tolerance) {
            vec4 previous = texelFetch(uPrevAccum, previousPixel, 0);
            historyCount = previous.a * uHistoryRetain;
            historyColor = previous.rgb;
          }
        }
      }
    }
  }

  uint pixelSeed = pcg(uint(pixel.x) + uint(pixel.y) * uint(uResolution.x) + uSeed * 0x9E3779B9u);
  vec3 sampleSum = vec3(0.0);
  for (int sampleIndex = 0; sampleIndex < uSamplesPerFrame; sampleIndex++) {
    uint state = pcg(pixelSeed + uint(sampleIndex) * 0x9E3779B9u + 0x85EBCA6Bu);
    vec2 jitter = vec2(randomFloat(state), randomFloat(state));
    vec2 sampleUv = (vec2(gl_FragCoord.xy) + jitter) / uResolution;
    vec3 direction = cameraDirection(sampleUv);
    sampleSum += tracePath(uCameraPosition, direction, state);
  }

  float newCount = historyCount + float(uSamplesPerFrame);
  vec3 accumulated = newCount > 0.0 ? (historyColor * historyCount + sampleSum) / newCount : vec3(0.0);
  outColor = vec4(min(accumulated, vec3(64.0)), newCount);
  outPosition = vec4(primaryPosition, primaryValid);
}
`;
