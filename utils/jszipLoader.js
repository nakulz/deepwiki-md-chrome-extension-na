import '../lib/jszip.min.js';

const { JSZip } = globalThis;

if (!JSZip) {
  throw new Error('Failed to load JSZip library');
}

export default JSZip;
