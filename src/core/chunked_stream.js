/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  arrayByteLength,
  arraysToBytes,
  createPromiseCapability,
} from "../shared/util.js";
import { MissingDataException } from "./core_utils.js";
import { Stream } from "./stream.js";

const ALLOCATE_NO_CHUNKS_SIZE = 4 * 1024 * 1024;

class ChunkedStream extends Stream {
  constructor(length, chunkSize, manager) {
    super(
      /* arrayBuffer = */ new Uint8Array(length),
      /* start = */ 0,
      /* length = */ length,
      /* dict = */ null
    );

    this.chunkSize = chunkSize;
    this.loadedChunks = [];
    this.numChunks = Math.ceil(length / chunkSize);
    this.manager = manager;
    this.progressiveDataLength = 0;
    this.lastSuccessfulEnsureByteChunk = -1; // Single-entry cache
  }

  // If a particular stream does not implement one or more of these methods,
  // an error should be thrown.
  getMissingChunks() {
    const chunks = [];
    for (let chunk = 0, n = this.numChunks; chunk < n; ++chunk) {
      if (!this.loadedChunks[chunk]) {
        chunks.push(chunk);
      }
    }
    return chunks;
  }

  get numChunksLoaded() {
    return this.loadedChunks.length;
  }

  get isDataLoaded() {
    return this.numChunksLoaded === this.numChunks;
  }

  onReceiveData(begin, chunk) {
    const chunkSize = this.chunkSize;
    if (begin % chunkSize !== 0) {
      throw new Error(`Bad begin offset: ${begin}`);
    }

    // Using `this.length` is inaccurate here since `this.start` can be moved
    // (see the `moveStart` method).
    const end = begin + chunk.byteLength;
    if (end % chunkSize !== 0 && end !== this.bytes.length) {
      throw new Error(`Bad end offset: ${end}`);
    }

    this.bytes.set(new Uint8Array(chunk), begin);
    const beginChunk = Math.floor(begin / chunkSize);
    const endChunk = Math.floor((end - 1) / chunkSize) + 1;

    for (let curChunk = beginChunk; curChunk < endChunk; ++curChunk) {
      // Since a value can only occur *once* in a `Set`, there's no need to
      // manually check `Set.prototype.has()` before adding the value here.
      if (!this.loadedChunks[curChunk]) {
        this.loadedChunks[curChunk] = true;
      }
    }
  }

  onReceiveProgressiveData(data) {
    let position = this.progressiveDataLength;
    const beginChunk = Math.floor(position / this.chunkSize);

    this.bytes.set(new Uint8Array(data), position);
    position += data.byteLength;
    this.progressiveDataLength = position;
    const endChunk =
      position >= this.end
        ? this.numChunks
        : Math.floor(position / this.chunkSize);

    for (let curChunk = beginChunk; curChunk < endChunk; ++curChunk) {
      // Since a value can only occur *once* in a `Set`, there's no need to
      // manually check `Set.prototype.has()` before adding the value here.
      if (!this.loadedChunks[curChunk]) {
        this.loadedChunks[curChunk] = true;
      }
    }
  }

  ensureByte(pos) {
    if (pos < this.progressiveDataLength) {
      return;
    }

    const chunk = Math.floor(pos / this.chunkSize);
    if (chunk === this.lastSuccessfulEnsureByteChunk) {
      return;
    }

    if (!this.loadedChunks[chunk]) {
      throw new MissingDataException(pos, pos + 1);
    }
    this.lastSuccessfulEnsureByteChunk = chunk;
  }

  ensureRange(begin, end) {
    if (begin >= end) {
      return;
    }
    if (end <= this.progressiveDataLength) {
      return;
    }

    const chunkSize = this.chunkSize;
    const beginChunk = Math.floor(begin / chunkSize);
    const endChunk = Math.floor((end - 1) / chunkSize) + 1;
    for (let chunk = beginChunk; chunk < endChunk; ++chunk) {
      if (!this.loadedChunks[chunk]) {
        throw new MissingDataException(begin, end);
      }
    }
  }

  nextEmptyChunk(beginChunk) {
    const numChunks = this.numChunks;
    for (let i = 0; i < numChunks; ++i) {
      const chunk = (beginChunk + i) % numChunks; // Wrap around to beginning.
      if (!this.loadedChunks[chunk]) {
        return chunk;
      }
    }
    return null;
  }

  hasChunk(chunk) {
    return !!this.loadedChunks[chunk];
  }

  getByte() {
    const pos = this.pos;
    if (pos >= this.end) {
      return -1;
    }
    if (pos >= this.progressiveDataLength) {
      this.ensureByte(pos);
    }
    return this.bytes[this.pos++];
  }

  getBytes(length, forceClamped = false) {
    const bytes = this.bytes;
    const pos = this.pos;
    const strEnd = this.end;

    if (!length) {
      if (strEnd > this.progressiveDataLength) {
        this.ensureRange(pos, strEnd);
      }
      const subarray = bytes.subarray(pos, strEnd);
      // `this.bytes` is always a `Uint8Array` here.
      return forceClamped ? new Uint8ClampedArray(subarray) : subarray;
    }

    let end = pos + length;
    if (end > strEnd) {
      end = strEnd;
    }
    if (end > this.progressiveDataLength) {
      this.ensureRange(pos, end);
    }

    this.pos = end;
    const subarray = bytes.subarray(pos, end);
    // `this.bytes` is always a `Uint8Array` here.
    return forceClamped ? new Uint8ClampedArray(subarray) : subarray;
  }

  getByteRange(begin, end) {
    if (begin < 0) {
      begin = 0;
    }
    if (end > this.end) {
      end = this.end;
    }
    if (end > this.progressiveDataLength) {
      this.ensureRange(begin, end);
    }
    return this.bytes.subarray(begin, end);
  }

  makeSubStream(start, length, dict = null) {
    if (length) {
      if (start + length > this.progressiveDataLength) {
        this.ensureRange(start, start + length);
      }
    } else {
      // When the `length` is undefined you do *not*, under any circumstances,
      // want to fallback on calling `this.ensureRange(start, this.end)` since
      // that would force the *entire* PDF file to be loaded, thus completely
      // breaking the whole purpose of using streaming and/or range requests.
      //
      // However, not doing any checking here could very easily lead to wasted
      // time/resources during e.g. parsing, since `MissingDataException`s will
      // require data to be re-parsed, which we attempt to minimize by at least
      // checking that the *beginning* of the data is available here.
      if (start >= this.progressiveDataLength) {
        this.ensureByte(start);
      }
    }

    function ChunkedStreamSubstream() { }
    ChunkedStreamSubstream.prototype = Object.create(this);
    ChunkedStreamSubstream.prototype.getMissingChunks = function () {
      const chunkSize = this.chunkSize;
      const beginChunk = Math.floor(this.start / chunkSize);
      const endChunk = Math.floor((this.end - 1) / chunkSize) + 1;
      const missingChunks = [];
      for (let chunk = beginChunk; chunk < endChunk; ++chunk) {
        if (!this.loadedChunks[chunk]) {
          missingChunks.push(chunk);
        }
      }
      return missingChunks;
    };
    Object.defineProperty(ChunkedStreamSubstream.prototype, "isDataLoaded", {
      get() {
        if (this.numChunksLoaded === this.numChunks) {
          return true;
        }
        return this.getMissingChunks().length === 0;
      },
      configurable: true,
    });

    const subStream = new ChunkedStreamSubstream();
    subStream.pos = subStream.start = start;
    subStream.end = start + length || this.end;
    subStream.dict = dict;
    return subStream;
  }

  getBaseStreams() {
    return [this];
  }
}

class ChunkedStreamContinuous extends ChunkedStream {
  constructor(length, chunkSize, manager) {
    super(length, chunkSize, manager);
    console.log("ChunkedStreamContinuous", this);

    this.progressiveData = null;
    this.progressiveDataChunkPosition = 0;
    this.buffer = {
      startOffset: 0,
      start: 0,
      end: 0,
      buffer: new Uint8Array(length)
    };

    this.initialChunk = null;
    this.totalLength = length;
    this.bufferCache = [];
    this.isStream = true;
  }

  ensureByte(pos) {
    this.prepareBuffer(pos, pos + 1);
  }

  ensureRange(begin, end) {
    if (begin >= end) return;

    this.prepareBuffer(begin, end);
  }

  getByte() {
    const pos = this.pos;
    if (pos >= this.end) {
      return -1;
    }
    const buffer = this.buffer;
    const bufferStart = buffer.start;

    if (pos >= bufferStart && pos < buffer.end) {
      this.pos++;
      return buffer.buffer[pos - buffer.startOffset];
    }

    this.prepareBuffer(pos, pos + 1);
    const byte = this.buffer.buffer[pos - this.buffer.startOffset];

    this.pos++;
    return byte;
  }

  getUint16() {
    const pos = this.pos;
    this.prepareBuffer(pos, pos + 2);
    const b0 = this.buffer.buffer[pos - this.buffer.startOffset];
    const b1 = this.buffer.buffer[pos + 1 - this.buffer.startOffset];

    this.pos += 2;
    if (b0 === -1 || b1 === -1) {
      return -1;
    }
    return (b0 << 8) + b1;
  }

  getInt32() {
    const pos = this.pos;
    this.prepareBuffer(pos, pos + 4);

    const b0 = this.buffer.buffer[pos - this.buffer.startOffset];
    const b1 = this.buffer.buffer[pos + 1 - this.buffer.startOffset];
    const b2 = this.buffer.buffer[pos + 2 - this.buffer.startOffset];
    const b3 = this.buffer.buffer[pos + 3 - this.buffer.startOffset];

    this.pos += 4;
    return (b0 << 24) + (b1 << 16) + (b2 << 8) + b3;
  }

  getBytes(length, forceClamped = false) {
    const pos = this.pos;
    const strEnd = this.end;

    if (!length) {
      this.ensureRange(pos, strEnd);

      return this.buffer.buffer.subarray(pos - this.buffer.startOffset, strEnd - this.buffer.startOffset);
    }

    let end = pos + length;
    if (end > strEnd) {
      end = strEnd;
    }

    this.ensureRange(pos, end);
    this.pos = end;
    return this.buffer.buffer.subarray(pos - this.buffer.startOffset, end - this.buffer.startOffset);
  }

  getByteRange(begin, end) {
    this.ensureRange(begin, end);
    return this.buffer.buffer.subarray(begin - this.buffer.startOffset, end - this.buffer.startOffset);
  }

  makeSubStream(start, length, dict = null) {
    function ChunkedStreamSubstream() { }
    ChunkedStreamSubstream.prototype = Object.create(this);
    ChunkedStreamSubstream.prototype.getMissingChunks = function () {
      const chunkSize = this.chunkSize;
      const beginChunk = Math.floor(this.start / chunkSize);
      const endChunk = Math.floor((this.end - 1) / chunkSize) + 1;
      const missingChunks = [];
      for (let chunk = beginChunk; chunk < endChunk; ++chunk) {
        if (!this.loadedChunks[chunk]) {
          missingChunks.push(chunk);
        }
      }
      return missingChunks;
    };
    Object.defineProperty(ChunkedStreamSubstream.prototype, "isDataLoaded", {
      get() {
        if (this.numChunksLoaded === this.numChunks) {
          return true;
        }
        return this.getMissingChunks().length === 0;
      },
      configurable: true,
    });

    const subStream = new ChunkedStreamSubstream();
    subStream.ensureRange(start, start + length);
    subStream.pos = subStream.start = start;
    subStream.end = start + length || this.end;
    subStream.dict = dict;
    subStream.totalLength = subStream.end - subStream.start;
    subStream.subStream = true;

    if (subStream.start >= subStream.buffer.start && subStream.end <= subStream.buffer.end) {
      // Stream is fully loaded, use fast getByteMethod
      subStream.getByte = this.createGetByteFast(subStream.buffer.buffer, subStream.end);
    }

    return subStream;
  }

  createGetByteFast(buffer, end) {
    const closureBuffer = buffer;
    const closureEnd = end;
    return function () {
      const pos = this.pos;
      if (pos >= closureEnd) {
        return -1;
      }
      this.pos++;
      return closureBuffer[pos];
    };
  }

  onReceiveProgressiveData(data) {
    const chunkSize = this.chunkSize;
    let position = this.progressiveDataLength;
    const beginChunk = Math.floor(position / this.chunkSize);

    this.buffer.buffer.set(new Uint8Array(data), position);
    position += data.byteLength;
    this.progressiveDataLength = position;
    const chunkEnd = position;
    const endChunk = position >= this.end ? this.numChunks : Math.floor(position / this.chunkSize);

    for (let curChunk = beginChunk; curChunk < endChunk; ++curChunk) {
      if (!(curChunk in this.loadedChunks)) {
        this.loadedChunks[curChunk] = {
          chunkOffset: chunkSize * curChunk,
          start: 0,
          startOffset: 0,
          end: chunkEnd,
          data: this.buffer.buffer
        };
        ++this.numChunksLoaded;
      } else {
        this.loadedChunks[curChunk].end = chunkEnd;
      }
    }
    // Merge chunks to the left.
    curChunk = beginChunk - 1;
    while (curChunk >= 0 && this.loadedChunks[curChunk]) {
      this.loadedChunks[curChunk--].end = chunkEnd;
    }

    if (this.numChunksLoaded === this.numChunks) {
      // stream is fully loaded, switch to fast getByte
      this.buffer.start = 0;
      this.buffer.startOffset = 0;
      this.buffer.end = this.buffer.buffer.byteLength;
      this.prepareBuffer = this.prepareBufferNop;
      this.getByte = this.createGetByteFast(this.buffer.buffer, this.end);
    }
  }

  onReceiveData(begin, chunk) {
    const chunkSize = this.chunkSize;
    let data = new Uint8Array(chunk);

    if (begin === 0 && data.byteLength % chunkSize !== 0) {
      this.initialChunk = {
        start: 0,
        startOffset: 0,
        end: 0,
        buffer: this.buffer.buffer
      };
      this.buffer.buffer.set(data, this.initialChunk.end);
      this.initialChunk.end += data.byteLength;

      if (data.byteLength > chunkSize) {
        data = data.subarray(0, data.byteLength - data.byteLength % chunkSize);
      } else {
        return;
      }
    }

    const end = begin + data.byteLength;

    // Using this.length is inaccurate here since this.start can be moved
    // See ChunkedStreamBase.moveStart()
    const beginChunk = Math.floor(begin / chunkSize);
    const endChunk = Math.floor((end - 1) / chunkSize) + 1;

    this.buffer.buffer.set(data, beginChunk * chunkSize);

    let chunkEnd = chunkSize * beginChunk + data.byteLength;
    if (this.loadedChunks[endChunk]) {
      chunkEnd = this.loadedChunks[endChunk].end;
    }

    for (let curChunk = beginChunk; curChunk < endChunk; ++curChunk) {
      if (!this.loadedChunks[curChunk]) {
        this.loadedChunks[curChunk] = {
          chunkOffset: chunkSize * curChunk,
          start: 0,
          startOffset: 0,
          end: chunkEnd,
          data: this.buffer.buffer
        };
        ++this.numChunksLoaded;
      }
    }
    // Merge chunks to the left.
    let curChunk = beginChunk - 1;
    while (curChunk >= 0 && this.loadedChunks[curChunk]) {
      this.loadedChunks[curChunk--].end = chunkEnd;
    }

    if (this.numChunksLoaded === this.numChunks) {
      // Stream is fully loaded, switch to fast getByte, prepareBuffer is no
      // longer needed since memory is continuous.
      this.initialChunk = null;
      this.buffer.start = 0;
      this.buffer.startOffset = 0;
      this.buffer.end = this.buffer.buffer.byteLength;
      this.getByte = this.createGetByteFast(this.buffer.buffer, this.end);
      this.prepareBuffer = this.prepareBufferNop;
    }
  }

  prepareBuffer(begin, end) {
    if (!end) {
      return;
    }

    // Checks if current buffer matches new [begin, end) parameters.
    if (this.buffer.start <= begin && end <= this.buffer.end || end <= this.progressiveDataLength) {
      return;
    }

    // Checks if there is initial block
    if (this.initialChunk && this.initialChunk.start <= begin &&
      end <= this.initialChunk.end) {
      this.buffer = this.initialChunk;
      return;
    }

    const chunkSize = this.chunkSize;
    const beginChunk = Math.floor(begin / chunkSize);
    const endChunk = Math.floor((end - 1) / chunkSize) + 1;
    // Check if there are missing chunks.
    for (let chunk = beginChunk; chunk < endChunk; ++chunk) {
      if (!this.loadedChunks[chunk]) {
        throw new MissingDataException(begin, end);
      }
    }

    this.buffer.startOffset = 0;
    this.buffer.start = begin;
    this.buffer.end = end;
  };
}

class ChunkedStreamFragmented extends ChunkedStream {
  constructor(length, chunkSize, manager) {
    super(length, chunkSize, manager);
    console.log("ChunkedStreamFragmented", this);

    this.progressiveData = null;
    this.progressiveDataChunkPosition = 0;
    this.buffer = {
      startOffset: -1,
      start: -1,
      end: -1,
      buffer: null
    };

    this.initialChunk = null;
    this.totalLength = length;
    this.bufferCache = [];
    this.isStream = true;
  }

  ensureByte(pos) {
    this.prepareBuffer(pos, pos + 1);
  }

  ensureRange(begin, end) {
    if (begin >= end) return;

    this.prepareBuffer(begin, end);
  }

  getByte() {
    const pos = this.pos;
    if (pos >= this.end) {
      return -1;
    }
    const buffer = this.buffer;
    const bufferStart = buffer.start;

    if (pos >= bufferStart && pos < buffer.end) {
      this.pos++;
      return buffer.buffer[pos - buffer.startOffset];
    }

    this.prepareBuffer(pos, pos + 1);
    const byte = this.buffer.buffer[pos - this.buffer.startOffset];

    this.pos++;
    return byte;
  }

  getUint16() {
    const pos = this.pos;
    this.prepareBuffer(pos, pos + 2);
    const b0 = this.buffer.buffer[pos - this.buffer.startOffset];
    const b1 = this.buffer.buffer[pos + 1 - this.buffer.startOffset];

    this.pos += 2;
    if (b0 === -1 || b1 === -1) {
      return -1;
    }
    return (b0 << 8) + b1;
  }

  getInt32() {
    const pos = this.pos;
    this.prepareBuffer(pos, pos + 4);

    const b0 = this.buffer.buffer[pos - this.buffer.startOffset];
    const b1 = this.buffer.buffer[pos + 1 - this.buffer.startOffset];
    const b2 = this.buffer.buffer[pos + 2 - this.buffer.startOffset];
    const b3 = this.buffer.buffer[pos + 3 - this.buffer.startOffset];

    this.pos += 4;
    return (b0 << 24) + (b1 << 16) + (b2 << 8) + b3;
  }

  getBytes(length, forceClamped = false) {
    const pos = this.pos;
    const strEnd = this.end;

    if (!length) {
      this.ensureRange(pos, strEnd);

      return this.buffer.buffer.subarray(pos - this.buffer.startOffset, strEnd - this.buffer.startOffset);
    }

    let end = pos + length;
    if (end > strEnd) {
      end = strEnd;
    }

    this.ensureRange(pos, end);
    this.pos = end;
    return this.buffer.buffer.subarray(pos - this.buffer.startOffset, end - this.buffer.startOffset);
  }

  getByteRange(begin, end) {
    this.ensureRange(begin, end);
    return this.buffer.buffer.subarray(begin - this.buffer.startOffset, end - this.buffer.startOffset);
  }

  makeSubStream(start, length, dict = null) {
    function ChunkedStreamSubstream() { }
    ChunkedStreamSubstream.prototype = Object.create(this);
    ChunkedStreamSubstream.prototype.getMissingChunks = function () {
      const chunkSize = this.chunkSize;
      const beginChunk = Math.floor(this.start / chunkSize);
      const endChunk = Math.floor((this.end - 1) / chunkSize) + 1;
      const missingChunks = [];
      for (let chunk = beginChunk; chunk < endChunk; ++chunk) {
        if (!this.loadedChunks[chunk]) {
          missingChunks.push(chunk);
        }
      }
      return missingChunks;
    };
    Object.defineProperty(ChunkedStreamSubstream.prototype, "isDataLoaded", {
      get() {
        if (this.numChunksLoaded === this.numChunks) {
          return true;
        }
        return this.getMissingChunks().length === 0;
      },
      configurable: true,
    });

    const subStream = new ChunkedStreamSubstream();
    subStream.ensureRange(start, start + length);
    subStream.pos = subStream.start = start;
    subStream.end = start + length || this.end;
    subStream.dict = dict;
    subStream.totalLength = subStream.end - subStream.start;
    subStream.subStream = true;

    if (subStream.start >= subStream.buffer.start && subStream.end <= subStream.buffer.end) {
      // Stream is fully loaded, use fast getByteMethod
      subStream.getByte = this.createGetByteFast(subStream.buffer.buffer, subStream.end);
    }

    return subStream;
  }

  createGetByteFast() {
    return this.getByteFast;
  }

  getByteFast() {
    const pos = this.pos;
    if (pos >= this.end) {
      return -1;
    }
    const buffer = this.buffer;

    this.pos++;
    return buffer.buffer[pos - buffer.startOffset];
  }

  onReceiveProgressiveData(data) {
    data = new Uint8Array(data);
    // progressiveDataLength is always aligned with chunk offsets.
    const position = this.progressiveDataLength;

    // First progressive data should be usable even if it is smaller than
    // chunk size.
    if (position === 0) {
      if (!this.initialChunk) {
        this.initialChunk = {
          start: 0,
          startOffset: 0,
          end: 0,
          buffer: new Uint8Array(Math.max(this.chunkSize, data.byteLength))
        };
      }
      this.initialChunk.buffer.set(
        data.subarray(0, Math.min(this.initialChunk.buffer.byteLength - this.initialChunk.end, data.byteLength)),
        this.initialChunk.end
      );
      this.initialChunk.end += data.byteLength;
    }

    const end = Math.min(position + data.byteLength + this.progressiveDataChunkPosition, this.end);

    let receiveData;
    let receiveDataSize = Math.floor((data.byteLength + this.progressiveDataChunkPosition) / this.chunkSize) * this.chunkSize;
    if (end === this.end) {
      receiveDataSize += end % this.chunkSize;
    }

    if (this.progressiveData === null) {
      // There is no stored progressive data yet.
      if (receiveDataSize === 0) {
        // Not enough data to fill a chunk.
        this.progressiveData = data;
        this.progressiveDataChunkPosition = data.byteLength;
        return;
      } else {
        // Enough data for one chunk or more.
        receiveData = data.subarray(0, receiveDataSize);
        if (data.byteLength > receiveDataSize) {
          // Leftover data
          this.progressiveData = data.subarray(receiveDataSize);
          this.progressiveDataChunkPosition = this.progressiveData.byteLength;
        } else {
          // Progress data size is aligned with chunk size (rare).
          this.progressiveData = null;
          this.progressiveDataChunkPosition = 0;
        }
      }
    } else {
      // Previous progress data that was not sent to onReceiveData exists.
      if (receiveDataSize > 0) {
        // Merged data will produce at least one chunk.
        receiveData = new Uint8Array(receiveDataSize);
        receiveData.set(this.progressiveData.subarray(0, this.progressiveDataChunkPosition));
        receiveData.set(
          data.subarray(0, receiveDataSize - this.progressiveDataChunkPosition),
          this.progressiveDataChunkPosition
        );

        const dataLeft = data.byteLength - (receiveDataSize - this.progressiveDataChunkPosition);
        if (dataLeft > 0) {
          // There is data left that won't be sent to onReceiveData yet.
          this.progressiveData = new Uint8Array(this.chunkSize);
          this.progressiveDataChunkPosition = dataLeft;
          this.progressiveData.set(data.subarray(data.byteLength - dataLeft));
        } else {
          this.progressiveData = null;
          this.progressiveDataChunkPosition = 0;
        }
      } else {
        // There is preexisting data but not enough to fill even one chunk.
        receiveData = new Uint8Array(this.chunkSize);
        receiveData.set(this.progressiveData, 0, this.progressiveDataChunkPosition);
        receiveData.set(data, this.progressiveDataChunkPosition);
        this.progressiveData = receiveData;
        this.progressiveDataChunkPosition += data.byteLength;
        return;
      }
    }

    this.onReceiveData(this.progressiveDataLength, receiveData);
    this.progressiveDataLength += receiveData.byteLength;
    if (this.initialChunk && this.progressiveDataLength >= this.initialChunk.end) {
      this.initialChunk = null;
    }
  }

  onReceiveData(begin, chunk) {
    const chunkSize = this.chunkSize;
    let data = new Uint8Array(chunk);

    if (begin === 0 && data.byteLength % chunkSize !== 0 && begin + data.byteLength !== this.end) {
      this.initialChunk = {
        start: 0,
        startOffset: 0,
        end: 0,
        buffer: new Uint8Array(Math.max(this.chunkSize, data.byteLength))
      };
      this.initialChunk.buffer.set(data, this.initialChunk.end);
      this.initialChunk.end += data.byteLength;

      if (data.byteLength > chunkSize) {
        data = data.subarray(0, data.byteLength - data.byteLength % chunkSize);
      } else {
        return;
      }
    }

    const end = begin + data.byteLength;

    // Using this.length is inaccurate here since this.start can be moved
    // See ChunkedStreamBase.moveStart()
    const beginChunk = Math.floor(begin / chunkSize);
    const endChunk = Math.floor((end - 1) / chunkSize) + 1;

    for (let curChunk = beginChunk; curChunk < endChunk; ++curChunk) {
      if (!this.loadedChunks[curChunk]) {
        this.loadedChunks[curChunk] = {
          chunkOffset: chunkSize * (curChunk - beginChunk),
          start: begin,
          startOffset: begin,
          end: begin + data.byteLength,
          data: data
        };
        ++this.numChunksLoaded;
      }
    }
  }

  prepareBuffer(begin, end) {
    if (!end) {
      return;
    }

    // Checks if current buffer matches new [begin, end) parameters.
    if (this.buffer.start <= begin && end <= this.buffer.end) {
      return;
    }

    // Checks if there is initial block
    if (this.initialChunk && this.initialChunk.start <= begin && end <= this.initialChunk.end) {
      this.buffer = this.initialChunk;
      return;
    }

    const chunkSize = this.chunkSize;
    const beginChunk = Math.floor(begin / chunkSize);
    const endChunk = Math.floor((end - 1) / chunkSize) + 1;
    // Check if there are missing chunks.
    for (let chunk = beginChunk; chunk < endChunk; ++chunk) {
      if (!this.loadedChunks[chunk]) {
        throw new MissingDataException(begin, end);
      }
    }

    // Check if we can reuse chunk data as buffer
    if (this.loadedChunks[beginChunk].data === this.loadedChunks[endChunk - 1].data) {
      // Use chunk data as buffer.
      this.buffer = {
        start: this.loadedChunks[beginChunk].start,
        startOffset: this.loadedChunks[beginChunk].start,
        end: this.loadedChunks[beginChunk].end,
        buffer: this.loadedChunks[beginChunk].data
      };
      return;
    }
    const bufferSize = (endChunk - beginChunk + 1) * chunkSize;
    this.buffer = {
      startOffset: beginChunk * chunkSize,
      start: beginChunk * chunkSize,
      end: beginChunk * chunkSize,
      buffer: new Uint8Array(bufferSize)
    };
    // copy data into buffer
    for (let chunk = beginChunk; chunk <= endChunk; ++chunk) {
      const chunkInfo = this.loadedChunks[chunk];
      if (!chunkInfo) {
        continue;
      }
      const srcOffset = (chunk - beginChunk) * chunkSize;
      const srcEnd = Math.min(chunkInfo.chunkOffset + chunkSize, chunkInfo.data.byteLength);
      const part = chunkInfo.data.subarray(chunkInfo.chunkOffset, srcEnd);
      this.buffer.end += part.byteLength;
      this.buffer.buffer.set(part, srcOffset);
    }
  }
}

class ChunkedStreamManager {
  constructor(pdfNetworkStream, args) {
    this.length = args.length;
    this.chunkSize = args.rangeChunkSize;
    this.stream = this.length > ALLOCATE_NO_CHUNKS_SIZE
      ? new ChunkedStreamFragmented(this.length, this.chunkSize, this)
      : new ChunkedStreamContinuous(this.length, this.chunkSize, this);
    this.pdfNetworkStream = pdfNetworkStream;
    this.disableAutoFetch = args.disableAutoFetch;
    this.msgHandler = args.msgHandler;

    this.currRequestId = 0;

    this._chunksNeededByRequest = new Map();
    this._requestsByChunk = new Map();
    this._promisesByRequest = new Map();
    this.progressiveDataLength = 0;
    this.aborted = false;

    this._loadedStreamCapability = createPromiseCapability();
  }

  onLoadedStream() {
    return this._loadedStreamCapability.promise;
  }

  sendRequest(begin, end) {
    const rangeReader = this.pdfNetworkStream.getRangeReader(begin, end);
    if (!rangeReader.isStreamingSupported) {
      rangeReader.onProgress = this.onProgress.bind(this);
    }

    let chunks = [],
      loaded = 0;
    const promise = new Promise((resolve, reject) => {
      const readChunk = chunk => {
        try {
          if (!chunk.done) {
            const data = chunk.value;
            chunks.push(data);
            loaded += arrayByteLength(data);
            if (rangeReader.isStreamingSupported) {
              this.onProgress({ loaded });
            }
            rangeReader.read().then(readChunk, reject);
            return;
          }
          const chunkData = arraysToBytes(chunks);
          chunks = null;
          resolve(chunkData);
        } catch (e) {
          reject(e);
        }
      };
      rangeReader.read().then(readChunk, reject);
    });
    promise.then(data => {
      if (this.aborted) {
        return; // Ignoring any data after abort.
      }
      this.onReceiveData({ chunk: data, begin });
    });
    // TODO check errors
  }

  /**
   * Get all the chunks that are not yet loaded and group them into
   * contiguous ranges to load in as few requests as possible.
   */
  requestAllChunks() {
    const missingChunks = this.stream.getMissingChunks();
    this._requestChunks(missingChunks);
    return this._loadedStreamCapability.promise;
  }

  _requestChunks(chunks) {
    const requestId = this.currRequestId++;

    const chunksNeeded = new Set();
    this._chunksNeededByRequest.set(requestId, chunksNeeded);
    for (const chunk of chunks) {
      if (!this.stream.hasChunk(chunk)) {
        chunksNeeded.add(chunk);
      }
    }

    if (chunksNeeded.size === 0) {
      return Promise.resolve();
    }

    const capability = createPromiseCapability();
    this._promisesByRequest.set(requestId, capability);

    const chunksToRequest = [];
    for (const chunk of chunksNeeded) {
      let requestIds = this._requestsByChunk.get(chunk);
      if (!requestIds) {
        requestIds = [];
        this._requestsByChunk.set(chunk, requestIds);

        chunksToRequest.push(chunk);
      }
      requestIds.push(requestId);
    }

    if (chunksToRequest.length > 0) {
      const groupedChunksToRequest = this.groupChunks(chunksToRequest);
      for (const groupedChunk of groupedChunksToRequest) {
        const begin = groupedChunk.beginChunk * this.chunkSize;
        const end = Math.min(
          groupedChunk.endChunk * this.chunkSize,
          this.length
        );
        this.sendRequest(begin, end);
      }
    }

    return capability.promise.catch(reason => {
      if (this.aborted) {
        return; // Ignoring any pending requests after abort.
      }
      throw reason;
    });
  }

  getStream() {
    return this.stream;
  }

  /**
   * Loads any chunks in the requested range that are not yet loaded.
   */
  requestRange(begin, end) {
    end = Math.min(end, this.length);

    const beginChunk = this.getBeginChunk(begin);
    const endChunk = this.getEndChunk(end);

    const chunks = [];
    for (let chunk = beginChunk; chunk < endChunk; ++chunk) {
      chunks.push(chunk);
    }
    return this._requestChunks(chunks);
  }

  requestRanges(ranges = []) {
    const chunksToRequest = [];
    for (const range of ranges) {
      const beginChunk = this.getBeginChunk(range.begin);
      const endChunk = this.getEndChunk(range.end);
      for (let chunk = beginChunk; chunk < endChunk; ++chunk) {
        if (!chunksToRequest.includes(chunk)) {
          chunksToRequest.push(chunk);
        }
      }
    }

    chunksToRequest.sort(function (a, b) {
      return a - b;
    });
    return this._requestChunks(chunksToRequest);
  }

  /**
   * Groups a sorted array of chunks into as few contiguous larger
   * chunks as possible.
   */
  groupChunks(chunks) {
    const groupedChunks = [];
    let beginChunk = -1;
    let prevChunk = -1;

    for (let i = 0, ii = chunks.length; i < ii; ++i) {
      const chunk = chunks[i];
      if (beginChunk < 0) {
        beginChunk = chunk;
      }

      if (prevChunk >= 0 && prevChunk + 1 !== chunk) {
        groupedChunks.push({ beginChunk, endChunk: prevChunk + 1 });
        beginChunk = chunk;
      }
      if (i + 1 === chunks.length) {
        groupedChunks.push({ beginChunk, endChunk: chunk + 1 });
      }

      prevChunk = chunk;
    }
    return groupedChunks;
  }

  onProgress(args) {
    this.msgHandler.send("DocProgress", {
      loaded: this.stream.numChunksLoaded * this.chunkSize + args.loaded,
      total: this.length,
    });
  }

  onReceiveData(args) {
    const chunk = args.chunk;
    const isProgressive = args.begin === undefined;
    const begin = isProgressive ? this.progressiveDataLength : args.begin;
    const end = begin + chunk.byteLength;

    const beginChunk = Math.floor(begin / this.chunkSize);
    const endChunk =
      end < this.length
        ? Math.floor(end / this.chunkSize)
        : Math.ceil(end / this.chunkSize);

    if (isProgressive) {
      this.stream.onReceiveProgressiveData(chunk);
      this.progressiveDataLength = end;
    } else {
      this.stream.onReceiveData(begin, chunk);
    }

    if (this.stream.isDataLoaded) {
      this._loadedStreamCapability.resolve(this.stream);
    }

    const loadedRequests = [];
    for (let curChunk = beginChunk; curChunk < endChunk; ++curChunk) {
      // The server might return more chunks than requested.
      const requestIds = this._requestsByChunk.get(curChunk);
      if (!requestIds) {
        continue;
      }
      this._requestsByChunk.delete(curChunk);

      for (const requestId of requestIds) {
        const chunksNeeded = this._chunksNeededByRequest.get(requestId);
        if (chunksNeeded.has(curChunk)) {
          chunksNeeded.delete(curChunk);
        }

        if (chunksNeeded.size > 0) {
          continue;
        }
        loadedRequests.push(requestId);
      }
    }

    // If there are no pending requests, automatically fetch the next
    // unfetched chunk of the PDF file.
    if (!this.disableAutoFetch && this._requestsByChunk.size === 0) {
      let nextEmptyChunk;
      if (this.stream.numChunksLoaded === 1) {
        // This is a special optimization so that after fetching the first
        // chunk, rather than fetching the second chunk, we fetch the last
        // chunk.
        const lastChunk = this.stream.numChunks - 1;
        if (!this.stream.hasChunk(lastChunk)) {
          nextEmptyChunk = lastChunk;
        }
      } else {
        nextEmptyChunk = this.stream.nextEmptyChunk(endChunk);
      }
      if (Number.isInteger(nextEmptyChunk)) {
        this._requestChunks([nextEmptyChunk]);
      }
    }

    for (const requestId of loadedRequests) {
      const capability = this._promisesByRequest.get(requestId);
      this._promisesByRequest.delete(requestId);
      capability.resolve();
    }

    this.msgHandler.send("DocProgress", {
      loaded: this.stream.numChunksLoaded * this.chunkSize,
      total: this.length,
    });
  }

  onError(err) {
    this._loadedStreamCapability.reject(err);
  }

  getBeginChunk(begin) {
    return Math.floor(begin / this.chunkSize);
  }

  getEndChunk(end) {
    return Math.floor((end - 1) / this.chunkSize) + 1;
  }

  abort(reason) {
    this.aborted = true;
    if (this.pdfNetworkStream) {
      this.pdfNetworkStream.cancelAllRequests(reason);
    }
    for (const capability of this._promisesByRequest.values()) {
      capability.reject(reason);
    }
  }
}

export { ChunkedStream, ChunkedStreamManager };
