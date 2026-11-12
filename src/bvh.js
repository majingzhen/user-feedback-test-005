const MAX_PRIMS = 8;
const MAX_NODES = 16;

const boundsOf = (primitive) => {
  if (primitive.type === "sphere") {
    const [x, y, z] = primitive.center;
    const r = primitive.radius;
    return {
      min: [x - r, y - r, z - r],
      max: [x + r, y + r, z + r],
    };
  }
  const { corner, u, v } = primitive;
  const points = [
    corner,
    [corner[0] + u[0], corner[1] + u[1], corner[2] + u[2]],
    [corner[0] + v[0], corner[1] + v[1], corner[2] + v[2]],
    [corner[0] + u[0] + v[0], corner[1] + u[1] + v[1], corner[2] + u[2] + v[2]],
  ];
  return {
    min: [0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis]))),
    max: [0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis]))),
  };
};

const centroidOf = (bounds) => [
  (bounds.min[0] + bounds.max[0]) * 0.5,
  (bounds.min[1] + bounds.max[1]) * 0.5,
  (bounds.min[2] + bounds.max[2]) * 0.5,
];

const unionBounds = (items) => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const item of items) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], item.bounds.min[axis]);
      max[axis] = Math.max(max[axis], item.bounds.max[axis]);
    }
  }
  return { min, max };
};

export const buildBVH = (primitives) => {
  if (primitives.length > MAX_PRIMS) throw new Error(`BVH 最多支持 ${MAX_PRIMS} 个图元`);

  const items = primitives.map((primitive, index) => {
    const bounds = boundsOf(primitive);
    return { index, bounds, centroid: centroidOf(bounds) };
  });

  const nodes = [];
  const indices = [];

  const build = (subset) => {
    const nodeIndex = nodes.length;
    if (nodes.length >= MAX_NODES) throw new Error(`BVH 节点数超过上限 ${MAX_NODES}`);
    nodes.push(null);

    const bounds = unionBounds(subset);
    if (subset.length <= 2) {
      const first = indices.length;
      for (const item of subset) indices.push(item.index);
      nodes[nodeIndex] = {
        min: bounds.min,
        max: bounds.max,
        left: -1,
        right: -1,
        first,
        count: subset.length,
      };
      return nodeIndex;
    }

    const extent = [0, 1, 2].map((axis) => bounds.max[axis] - bounds.min[axis]);
    const axis = extent.indexOf(Math.max(...extent));
    const sorted = [...subset].sort((a, b) => a.centroid[axis] - b.centroid[axis]);
    const middle = Math.floor(sorted.length / 2);
    nodes[nodeIndex] = {
      min: bounds.min,
      max: bounds.max,
      left: -1,
      right: -1,
      first: -1,
      count: 0,
    };
    const left = build(sorted.slice(0, middle));
    const right = build(sorted.slice(middle));
    nodes[nodeIndex].left = left;
    nodes[nodeIndex].right = right;
    return nodeIndex;
  };

  build(items);

  const nodeMin = new Float32Array(MAX_NODES * 4);
  const nodeMax = new Float32Array(MAX_NODES * 4);
  const nodeMeta = new Int32Array(MAX_NODES * 4);
  nodes.forEach((node, index) => {
    nodeMin[index * 4 + 0] = node.min[0];
    nodeMin[index * 4 + 1] = node.min[1];
    nodeMin[index * 4 + 2] = node.min[2];
    nodeMin[index * 4 + 3] = 0;
    nodeMax[index * 4 + 0] = node.max[0];
    nodeMax[index * 4 + 1] = node.max[1];
    nodeMax[index * 4 + 2] = node.max[2];
    nodeMax[index * 4 + 3] = 0;
    nodeMeta[index * 4 + 0] = node.left;
    nodeMeta[index * 4 + 1] = node.right;
    nodeMeta[index * 4 + 2] = node.first;
    nodeMeta[index * 4 + 3] = node.count;
  });

  const indexArray = new Int32Array(MAX_PRIMS);
  indices.forEach((value, index) => {
    indexArray[index] = value;
  });

  return {
    nodes,
    indices,
    nodeCount: nodes.length,
    primCount: primitives.length,
    nodeMin,
    nodeMax,
    nodeMeta,
    indexArray,
  };
};

export const bvhConstants = { MAX_PRIMS, MAX_NODES };
