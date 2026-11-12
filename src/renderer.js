import { bvhConstants } from "./bvh.js";
import { ENVIRONMENT } from "./scene.js";
import { displayFragmentShader, fullscreenVertexShader } from "./shaders/common.js";
import { pathTracerFragmentShader } from "./shaders/trace.js";

const TAN_HALF_FOV = Math.tan((38 * Math.PI) / 180 / 2);
const HISTORY_RETAIN = 0.88;
const HISTORY_SETTLE_FRAMES = 20;

const cameraCopy = (camera) => ({
  position: [...camera.position],
  forward: [...camera.forward],
  right: [...camera.right],
  up: [...camera.up],
});

const sameCamera = (a, b) => {
  if (!a || !b) return false;
  const near = (x, y) => Math.abs(x - y) < 1e-5;
  return (
    near(a.position[0], b.position[0]) &&
    near(a.position[1], b.position[1]) &&
    near(a.position[2], b.position[2]) &&
    near(a.forward[0], b.forward[0]) &&
    near(a.forward[1], b.forward[1]) &&
    near(a.forward[2], b.forward[2])
  );
};

export class PathTracer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!this.gl) throw new Error("当前浏览器无法创建 WebGL2 上下文。");
    this.floatLinear = false;
    this.targets = [];
    this.sceneData = null;
    this.options = {
      samplesPerFrame: 2,
      maxBounces: 6,
      exposure: 0,
      historyReprojection: true,
    };
    this.interacting = false;
    this.currentCamera = null;
    this.prevRenderedCamera = null;
    this.resetRequested = true;
    this.currentIndex = 0;
    this.frameSeed = 1;
    this.sampleEstimate = 0;
    this.historySettleFrames = 0;
    this.fps = 0;
    this.lastFrameTime = 0;
    this.width = 0;
    this.height = 0;
    this.ready = false;
  }

  init(width, height) {
    const gl = this.gl;
    if (!gl.getExtension("EXT_color_buffer_float")) {
      throw new Error("当前设备缺少 EXT_color_buffer_float，无法渲染浮点累积缓冲。");
    }
    this.floatLinear = Boolean(gl.getExtension("OES_texture_float_linear"));
    gl.getExtension("OES_texture_float_linear");

    this.traceProgram = this.createProgram(fullscreenVertexShader, pathTracerFragmentShader, "路径追踪");
    this.displayProgram = this.createProgram(fullscreenVertexShader, displayFragmentShader, "显示合成");
    this.traceUniforms = this.collectUniforms(this.traceProgram, [
      "uResolution",
      "uSeed",
      "uSamplesPerFrame",
      "uMaxBounces",
      "uHistoryMode",
      "uHistoryRetain",
      "uPrevAccum",
      "uPrevPosition",
      "uCameraPosition",
      "uCameraRight",
      "uCameraUp",
      "uCameraForward",
      "uTanHalfFov",
      "uAspect",
      "uPrevCameraPosition",
      "uPrevCameraRight",
      "uPrevCameraUp",
      "uPrevCameraForward",
      "uPrevTanHalfFov",
      "uPrevAspect",
      "uPrimCount",
      "uNodeCount",
      "uPrimA",
      "uPrimB",
      "uPrimC",
      "uPrimD",
      "uNodeMin",
      "uNodeMax",
      "uNodeMeta",
      "uPrimIndices",
      "uMaterialA",
      "uMaterialB",
      "uMaterialEmission",
      "uLightCorner",
      "uLightU",
      "uLightV",
      "uLightNormal",
      "uLightEmission",
      "uLightArea",
      "uEnvHorizon",
      "uEnvZenith",
      "uEnvGlow",
    ]);
    this.displayUniforms = this.collectUniforms(this.displayProgram, ["uAccum", "uResolution", "uExposure"]);

    this.createGeometry();
    this.resize(width, height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    this.ready = true;
  }

  createProgram(vertexSource, fragmentSource, label) {
    const gl = this.gl;
    const vertex = this.compileShader(gl.VERTEX_SHADER, vertexSource, `${label}顶点着色器`);
    const fragment = this.compileShader(gl.FRAGMENT_SHADER, fragmentSource, `${label}片元着色器`);
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.bindAttribLocation(program, 0, "aPosition");
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`${label}程序链接失败：\n${log}`);
    }
    return program;
  }

  compileShader(type, source, label) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`${label}编译失败：\n${log}`);
    }
    return shader;
  }

  collectUniforms(program, names) {
    const gl = this.gl;
    const uniforms = {};
    for (const name of names) uniforms[name] = gl.getUniformLocation(program, name);
    return uniforms;
  }

  createGeometry() {
    const gl = this.gl;
    const vertices = new Float32Array([-1, -1, 3, -1, -1, 3]);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.vertexBuffer = buffer;
  }

  createTarget(width, height) {
    const gl = this.gl;
    const createTexture = () => {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.floatLinear ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this.floatLinear ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
      return texture;
    };
    const accumulation = createTexture();
    const position = createTexture();
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, accumulation, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, position, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(accumulation);
      gl.deleteTexture(position);
      throw new Error(`累积 Framebuffer 不完整：0x${status.toString(16)}`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { accumulation, position, framebuffer };
  }

  clearTarget(target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  resize(width, height) {
    if (width === this.width && height === this.height && this.targets.length === 2) return;
    for (const target of this.targets) {
      this.gl.deleteFramebuffer(target.framebuffer);
      this.gl.deleteTexture(target.accumulation);
      this.gl.deleteTexture(target.position);
    }
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.targets = [this.createTarget(width, height), this.createTarget(width, height)];
    for (const target of this.targets) this.clearTarget(target);
    this.currentIndex = 0;
    this.resetRequested = true;
    this.prevRenderedCamera = null;
    this.sampleEstimate = 0;
    this.historySettleFrames = 0;
  }

  setScene(scene) {
    const gl = this.gl;
    const maxPrims = bvhConstants.MAX_PRIMS;
    const materialCount = 4;
    const primA = new Float32Array(maxPrims * 4);
    const primB = new Float32Array(maxPrims * 4);
    const primC = new Float32Array(maxPrims * 4);
    const primD = new Float32Array(maxPrims * 4);

    scene.primitives.forEach((primitive, index) => {
      const offset = index * 4;
      if (primitive.type === "sphere") {
        primA.set([primitive.center[0], primitive.center[1], primitive.center[2], primitive.radius], offset);
        primB.set([0, 0, 0, 0], offset);
        primC.set([0, 0, 0, 0], offset);
        primD.set([primitive.material, 0, 0, 0], offset);
      } else {
        primA.set([primitive.corner[0], primitive.corner[1], primitive.corner[2], 0], offset);
        primB.set([primitive.u[0], primitive.u[1], primitive.u[2], 0], offset);
        primC.set([primitive.v[0], primitive.v[1], primitive.v[2], 0], offset);
        const area = Math.hypot(...cross(primitive.u, primitive.v));
        primD.set([primitive.material, 1, area, 0], offset);
      }
    });

    const materialA = new Float32Array(materialCount * 4);
    const materialB = new Float32Array(materialCount * 4);
    const materialEmission = new Float32Array(materialCount * 4);
    scene.materials.forEach((material, index) => {
      const offset = index * 4;
      materialA.set([material.albedo[0], material.albedo[1], material.albedo[2], material.type], offset);
      materialB.set([material.roughness, material.ior, 0, 0], offset);
      materialEmission.set(
        [material.emission[0], material.emission[1], material.emission[2], 0],
        offset
      );
    });

    this.sceneData = {
      primA,
      primB,
      primC,
      primD,
      nodeMin: scene.bvh.nodeMin,
      nodeMax: scene.bvh.nodeMax,
      nodeMeta: scene.bvh.nodeMeta,
      indexArray: scene.bvh.indexArray,
      primCount: scene.bvh.primCount,
      nodeCount: scene.bvh.nodeCount,
      materialA,
      materialB,
      materialEmission,
      light: scene.light,
    };
    this.clearAllTargets();
    gl.useProgram(this.traceProgram);
    this.uploadSceneUniforms();
    this.resetRequested = true;
    this.sampleEstimate = 0;
  }

  clearAllTargets() {
    for (const target of this.targets) this.clearTarget(target);
  }

  setCamera(camera) {
    this.currentCamera = cameraCopy(camera);
  }

  setOptions(options) {
    this.options = { ...this.options, ...options };
  }

  setInteracting(value) {
    this.interacting = Boolean(value);
  }

  resetAccumulation() {
    this.clearAllTargets();
    this.sampleEstimate = 0;
    this.resetRequested = true;
    this.prevRenderedCamera = null;
    this.historySettleFrames = 0;
  }

  uploadSceneUniforms() {
    if (!this.sceneData) return;
    const gl = this.gl;
    const u = this.traceUniforms;
    const scene = this.sceneData;
    if (u.uPrimA) gl.uniform4fv(u.uPrimA, scene.primA);
    if (u.uPrimB) gl.uniform4fv(u.uPrimB, scene.primB);
    if (u.uPrimC) gl.uniform4fv(u.uPrimC, scene.primC);
    if (u.uPrimD) gl.uniform4fv(u.uPrimD, scene.primD);
    if (u.uNodeMin) gl.uniform4fv(u.uNodeMin, scene.nodeMin);
    if (u.uNodeMax) gl.uniform4fv(u.uNodeMax, scene.nodeMax);
    if (u.uNodeMeta) gl.uniform4iv(u.uNodeMeta, scene.nodeMeta);
    if (u.uPrimIndices) gl.uniform1iv(u.uPrimIndices, scene.indexArray);
    if (u.uPrimCount) gl.uniform1i(u.uPrimCount, scene.primCount);
    if (u.uNodeCount) gl.uniform1i(u.uNodeCount, scene.nodeCount);
    if (u.uMaterialA) gl.uniform4fv(u.uMaterialA, scene.materialA);
    if (u.uMaterialB) gl.uniform4fv(u.uMaterialB, scene.materialB);
    if (u.uMaterialEmission) gl.uniform4fv(u.uMaterialEmission, scene.materialEmission);
    if (u.uLightCorner) gl.uniform3fv(u.uLightCorner, scene.light.corner);
    if (u.uLightU) gl.uniform3fv(u.uLightU, scene.light.u);
    if (u.uLightV) gl.uniform3fv(u.uLightV, scene.light.v);
    if (u.uLightNormal) gl.uniform3fv(u.uLightNormal, scene.light.normal);
    if (u.uLightEmission) gl.uniform3fv(u.uLightEmission, scene.light.emission);
    if (u.uLightArea) gl.uniform1f(u.uLightArea, scene.light.area);
    if (u.uEnvHorizon) gl.uniform3fv(u.uEnvHorizon, ENVIRONMENT.horizon);
    if (u.uEnvZenith) gl.uniform3fv(u.uEnvZenith, ENVIRONMENT.zenith);
    if (u.uEnvGlow) gl.uniform3fv(u.uEnvGlow, ENVIRONMENT.glow);
  }

  cameraIsDifferent() {
    return this.prevRenderedCamera !== null && !sameCamera(this.currentCamera, this.prevRenderedCamera);
  }

  renderFrame(timestamp) {
    if (!this.ready || !this.sceneData || !this.currentCamera) return null;
    const gl = this.gl;
    const currentSpp = this.interacting ? 1 : this.options.samplesPerFrame;
    const cameraMoved = this.cameraIsDifferent();
    let historyMode;
    if (this.resetRequested || !this.prevRenderedCamera) {
      historyMode = 0;
      this.historySettleFrames = 0;
    } else if (cameraMoved) {
      if (this.options.historyReprojection) {
        historyMode = 2;
        this.historySettleFrames = HISTORY_SETTLE_FRAMES;
      } else {
        historyMode = 0;
        this.historySettleFrames = 0;
      }
    } else {
      historyMode = 1;
    }
    const settling = historyMode !== 0 && this.historySettleFrames > 0;
    const historyRetain = historyMode === 2 || settling ? HISTORY_RETAIN : 1;

    if (historyMode === 0) this.sampleEstimate = 0;

    const writeIndex = 1 - this.currentIndex;
    const readTarget = this.targets[this.currentIndex];
    const writeTarget = this.targets[writeIndex];

    gl.bindFramebuffer(gl.FRAMEBUFFER, writeTarget.framebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.traceProgram);
    this.uploadSceneUniforms();

    const u = this.traceUniforms;
    if (u.uResolution) gl.uniform2f(u.uResolution, this.width, this.height);
    if (u.uSeed) gl.uniform1ui(u.uSeed, this.frameSeed >>> 0);
    if (u.uSamplesPerFrame) gl.uniform1i(u.uSamplesPerFrame, currentSpp);
    if (u.uMaxBounces) gl.uniform1i(u.uMaxBounces, this.options.maxBounces);
    if (u.uHistoryMode) gl.uniform1i(u.uHistoryMode, historyMode);
    if (u.uHistoryRetain) gl.uniform1f(u.uHistoryRetain, historyRetain);
    if (u.uTanHalfFov) gl.uniform1f(u.uTanHalfFov, TAN_HALF_FOV);
    if (u.uAspect) gl.uniform1f(u.uAspect, this.width / this.height);
    if (u.uCameraPosition) gl.uniform3fv(u.uCameraPosition, this.currentCamera.position);
    if (u.uCameraRight) gl.uniform3fv(u.uCameraRight, this.currentCamera.right);
    if (u.uCameraUp) gl.uniform3fv(u.uCameraUp, this.currentCamera.up);
    if (u.uCameraForward) gl.uniform3fv(u.uCameraForward, this.currentCamera.forward);

    const previousCamera = this.prevRenderedCamera || this.currentCamera;
    if (u.uPrevCameraPosition) gl.uniform3fv(u.uPrevCameraPosition, previousCamera.position);
    if (u.uPrevCameraRight) gl.uniform3fv(u.uPrevCameraRight, previousCamera.right);
    if (u.uPrevCameraUp) gl.uniform3fv(u.uPrevCameraUp, previousCamera.up);
    if (u.uPrevCameraForward) gl.uniform3fv(u.uPrevCameraForward, previousCamera.forward);
    if (u.uPrevTanHalfFov) gl.uniform1f(u.uPrevTanHalfFov, TAN_HALF_FOV);
    if (u.uPrevAspect) gl.uniform1f(u.uPrevAspect, this.width / this.height);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, readTarget.accumulation);
    if (u.uPrevAccum) gl.uniform1i(u.uPrevAccum, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, readTarget.position);
    if (u.uPrevPosition) gl.uniform1i(u.uPrevPosition, 1);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    this.currentIndex = writeIndex;
    if (historyMode === 0) {
      this.sampleEstimate = currentSpp;
    } else if (historyMode === 2 || settling) {
      this.sampleEstimate = this.sampleEstimate * historyRetain + currentSpp;
    } else {
      this.sampleEstimate += currentSpp;
    }
    if (this.historySettleFrames > 0) this.historySettleFrames -= 1;
    this.prevRenderedCamera = cameraCopy(this.currentCamera);
    this.resetRequested = false;
    this.frameSeed = (this.frameSeed + 1) >>> 0;

    if (this.lastFrameTime > 0 && timestamp > this.lastFrameTime) {
      const instant = 1000 / (timestamp - this.lastFrameTime);
      this.fps = this.fps > 0 ? this.fps * 0.9 + instant * 0.1 : instant;
    }
    this.lastFrameTime = timestamp;

    this.present();
    return {
      historyMode,
      cameraMoving: cameraMoved,
      rebuilding: cameraMoved || settling,
      spp: currentSpp,
      estimatedSpp: this.sampleEstimate,
      fps: this.fps,
    };
  }

  present() {
    if (!this.targets.length) return;
    const gl = this.gl;
    const target = this.targets[this.currentIndex];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.displayProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.accumulation);
    const u = this.displayUniforms;
    if (u.uAccum) gl.uniform1i(u.uAccum, 0);
    if (u.uResolution) gl.uniform2f(u.uResolution, this.width, this.height);
    if (u.uExposure) gl.uniform1f(u.uExposure, this.options.exposure);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  readSnapshot() {
    if (!this.ready || !this.targets.length) return null;
    const gl = this.gl;
    const pixelCount = this.width * this.height * 4;
    const accumulation = new Float32Array(pixelCount);
    const position = new Float32Array(pixelCount);
    const target = this.targets[this.currentIndex];
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, accumulation);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, position);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return {
      width: this.width,
      height: this.height,
      accumulation,
      position,
      sampleEstimate: this.sampleEstimate,
      frameSeed: this.frameSeed,
    };
  }

  restoreSnapshot(snapshot) {
    if (!this.ready) return false;
    if (!snapshot || snapshot.width !== this.width || snapshot.height !== this.height) return false;
    const gl = this.gl;
    const expected = this.width * this.height * 4;
    if (!snapshot.accumulation || snapshot.accumulation.length !== expected) return false;
    if (!snapshot.position || snapshot.position.length !== expected) return false;

    const target = this.targets[0];
    gl.bindTexture(gl.TEXTURE_2D, target.accumulation);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.width, this.height, 0, gl.RGBA, gl.FLOAT, snapshot.accumulation);
    gl.bindTexture(gl.TEXTURE_2D, target.position);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.width, this.height, 0, gl.RGBA, gl.FLOAT, snapshot.position);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.currentIndex = 0;
    this.sampleEstimate = Number.isFinite(snapshot.sampleEstimate) ? snapshot.sampleEstimate : 0;
    this.resetRequested = false;
    this.historySettleFrames = 0;
    this.prevRenderedCamera = this.currentCamera ? cameraCopy(this.currentCamera) : null;
    this.frameSeed = Number.isFinite(snapshot.frameSeed) ? snapshot.frameSeed : 1;
    this.lastFrameTime = 0;
    this.present();
    return true;
  }

  getStats() {
    return {
      fps: this.fps,
      estimatedSpp: this.sampleEstimate,
      width: this.width,
      height: this.height,
      ready: this.ready,
    };
  }
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
