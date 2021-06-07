/* globals expect, it, describe, beforeEach, Stream, ChunkedStreamContinuous,
   ChunkedStreamFragmented, Dict,  MissingDataException,
   ALLOCATE_NO_CHUNKS_SIZE, ChunkedStreamBase, jasmine */

"use strict";

describe("stream", function () {
  const arrayComparerThatFixesJasmineIssue786 = function (first, second) {

    const isFirstArray = Array.isArray(first) ||
      Object.prototype.toString.call(first.buffer) === "[object ArrayBuffer]";
    const isSecondArray = Array.isArray(second) ||
      Object.prototype.toString.call(second.buffer) === "[object ArrayBuffer]";

    if (isFirstArray || isSecondArray) {

      let i = first.length;
      if (i !== second.length) {
        return false;
      }

      while (i--) {
        if (first[i] !== second[i]) {
          return false;
        }
      }
      return true;
    }
  };

  beforeEach(function () {
    jasmine.addCustomEqualityTester(arrayComparerThatFixesJasmineIssue786);
  });

  function makeRange(size, start) {
    const offset = start || 0;
    let arr = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      arr[i] = i + 1 + offset;
    }
    return arr;
  }

  function expectMissingDataException(func, begin, end) {
    let err = null;
    try {
      func();
      expect(false).toBe(true);
    } catch (e) {
      err = e;
    }

    expect(err instanceof MissingDataException).toBe(true);
    expect(err.begin).toBe(begin);
    expect(err.end).toBe(end);
  }

  function testGetByteRange(stream, length, valueStart) {
    for (let i = 0; i < length; i++) {
      expect(stream.getByte()).toBe(i + valueStart);
    }
  }

  describe("ChunkedStream", function () {
    describe("initial data is chunked and ", function () {
      it("less than chunk size reports no chunks but has data", function () {
        const stream = new ChunkedStreamFragmented(33, 11, null);
        expect(stream instanceof ChunkedStreamContinuous).toBe(false);
        stream.onReceiveData(0, makeRange(10));
        expect(stream.hasChunk(0)).toBe(false);
        testGetByteRange(stream, 10, 1);
        expect(stream.initialChunk).toBeTruthy();
      });

      it("exactly chunk size reports single chunk with data", function () {
        const stream = new ChunkedStreamFragmented(33, 11, null);
        expect(stream instanceof ChunkedStreamContinuous).toBe(false);
        stream.onReceiveData(0, makeRange(11));
        expect(stream.hasChunk(0)).toBe(true);
        testGetByteRange(stream, 11, 1);
      });

      it("more than one chunk size but less than two reports single chunk with" +
        "data, data over one chunk is not lost", function () {
          const stream = new ChunkedStreamFragmented(33, 11, null);
          expect(stream instanceof ChunkedStreamContinuous).toBe(false);
          stream.onReceiveData(0, makeRange(13));
          expect(stream.hasChunk(0)).toBe(true);
          expect(stream.hasChunk(1)).toBe(false);
          testGetByteRange(stream, 11, 1);
          testGetByteRange(stream, 2, 12);
          expectMissingDataException(function () {
            stream.ensureRange(14, 15);
          }, 14, 15);
          expect(stream.initialChunk).toBeTruthy();
        });

      it("two times chunk size reports two chunk with data", function () {
        const stream = new ChunkedStreamFragmented(33, 11, null);
        stream.onReceiveData(0, makeRange(22));
        expect(stream.hasChunk(0)).toBe(true);
        expect(stream.hasChunk(1)).toBe(true);
        expect(stream.hasChunk(2)).toBe(false);
        testGetByteRange(stream, 22, 1);
        expectMissingDataException(function () {
          stream.ensureRange(22, 23);
        }, 22, 23);
        expect(stream.initialChunk).toBeNull();
      });

      it("using progressive with less than chunk size has data but no chunks",
        function () {
          const stream = new ChunkedStreamFragmented(33, 11, null);
          stream.onReceiveProgressiveData(makeRange(10));
          expect(stream.hasChunk(0)).toBe(false);
          testGetByteRange(stream, 10, 1);
          expect(stream.initialChunk).toBeTruthy();
          stream.onReceiveProgressiveData([9]);
          expect(stream.initialChunk).toBeNull();
        });

      it("using multiple progressive with total chunk size has data and chunk",
        function () {
          const stream = new ChunkedStreamFragmented(33, 11, null);
          stream.onReceiveProgressiveData(makeRange(10));
          stream.onReceiveProgressiveData(makeRange(1, 10));
          expect(stream.hasChunk(0)).toBe(true);
          testGetByteRange(stream, 11, 1);
          expect(stream.initialChunk).toBeNull();
        });

      it("progressive with more than one chunk size but less than two reports " +
        "single chunk with data, data over one chunk is not lost", function () {
          const stream = new ChunkedStreamFragmented(33, 11, null);
          stream.onReceiveProgressiveData(makeRange(13));
          expect(stream.hasChunk(0)).toBe(true);
          expect(stream.hasChunk(1)).toBe(false);
          testGetByteRange(stream, 11, 1);
          testGetByteRange(stream, 2, 12);
          expectMissingDataException(function () {
            stream.ensureRange(14, 15);
          }, 14, 15);
          expect(stream.initialChunk).toBeTruthy();
        });
    });

    describe("initial data is continuous and ", function () {
      it("less than chunk size reports no chunks but has data", function () {
        const stream = new ChunkedStreamContinuous(33, 11, null);
        expect(stream instanceof ChunkedStreamContinuous).toBe(true);
        stream.onReceiveData(0, makeRange(10));
        expect(stream.hasChunk(0)).toBe(false);
        testGetByteRange(stream, 10, 1);
      });

      it("exactly chunk size reports single chunk with data", function () {
        const stream = new ChunkedStreamContinuous(33, 11, null);
        stream.onReceiveData(0, makeRange(11));
        expect(stream.hasChunk(0)).toBe(true);
        testGetByteRange(stream, 11, 1);
      });

      it("more than one chunk size but less than two reports single chunk with" +
        " data, data over one chunk is not lost", function () {
          const stream = new ChunkedStreamContinuous(33, 11, null);
          stream.onReceiveData(0, makeRange(13));
          expect(stream.hasChunk(0)).toBe(true);
          expect(stream.hasChunk(1)).toBe(false);
          testGetByteRange(stream, 11, 1);
          testGetByteRange(stream, 2, 12);
          expectMissingDataException(function () {
            stream.ensureRange(14, 15);
          }, 14, 15);
          expect(stream.initialChunk).toBeTruthy();
        });

      it("two times chunk size reports two chunk with data", function () {
        const stream = new ChunkedStreamContinuous(33, 11, null);
        stream.onReceiveData(0, makeRange(22));
        expect(stream.hasChunk(0)).toBe(true);
        expect(stream.hasChunk(1)).toBe(true);
        expect(stream.hasChunk(2)).toBe(false);
        testGetByteRange(stream, 22, 1);
        expectMissingDataException(function () {
          stream.ensureRange(22, 23);
        }, 22, 23);
        expect(stream.initialChunk).toBeNull();
      });

      it("using progressive with less than chunk size has data but no chunks",
        function () {
          const stream = new ChunkedStreamContinuous(33, 11, null);

          stream.onReceiveProgressiveData(makeRange(10));
          expect(stream.hasChunk(0)).toBe(false);
          testGetByteRange(stream, 10, 1);
          expect(stream.initialChunk).toBeNull();
        });

      it("using multiple progressive with total chunk size has data and chunk",
        function () {
          const stream = new ChunkedStreamContinuous(33, 11, null);
          stream.onReceiveProgressiveData(makeRange(10));
          stream.onReceiveProgressiveData(makeRange(1, 10));
          expect(stream.hasChunk(0)).toBe(true);
          testGetByteRange(stream, 11, 1);
          expect(stream.initialChunk).toBeNull();
        });

      it("using multiple progressive with total chunk size larger than single " +
        "chunk has data and chunk", function () {
          const stream = new ChunkedStreamContinuous(33, 11, null);
          stream.onReceiveProgressiveData(makeRange(10));
          stream.onReceiveProgressiveData(makeRange(4, 10));
          expect(stream.hasChunk(0)).toBe(true);
          testGetByteRange(stream, 11, 1);
          expect(stream.initialChunk).toBeNull();
        });

      it("progressive with more than one chunk size but less than two reports " +
        "single chunk with data, data over one chunk is not lost", function () {
          const stream = new ChunkedStreamContinuous(33, 11, null);
          stream.onReceiveProgressiveData(makeRange(13));
          expect(stream.hasChunk(0)).toBe(true);
          expect(stream.hasChunk(1)).toBe(false);
          testGetByteRange(stream, 11, 1);
          testGetByteRange(stream, 2, 12);
          expectMissingDataException(function () {
            stream.ensureRange(14, 15);
          }, 14, 15);
          expect(stream.initialChunk).toBeNull();
        });
    });

    describe("getting full data chunked", function () {
      it("loads the whole file", function () {
        const stream = new ChunkedStreamFragmented(10, 1, null);
        stream.onReceiveData(0, makeRange(10));

        expect(stream.initialChunk).toBeNull();
        expect(stream.allChunksLoaded()).toBe(true);
        expect(stream.length).toBe(10);
      });

      it("has correct data", function () {
        const stream = new ChunkedStreamFragmented(10, 1, null);
        stream.onReceiveData(0, makeRange(10));

        testGetByteRange(stream, 10, 1);
        expect(stream.getByte()).toBe(-1);
        expect(stream.length).toBe(10);
        expect(stream.nextEmptyChunk(0)).toBeNull();
        expect(stream.buffer.start).toBe(0);
        expect(stream.buffer.end).toBe(10);

        for (let i = 0; i < 10; i++) {
          expect(stream.hasChunk(i)).toBe(true);
        }
        expect(stream.getByte()).toBe(-1);
      });
    });

    describe("getting full data continuous", function () {

      it("loads the whole file", function () {
        const stream = new ChunkedStreamContinuous(10, 1, null);
        stream.onReceiveData(0, makeRange(10));

        expect(stream instanceof ChunkedStreamContinuous).toBeTruthy();
        expect(stream.initialChunk).toBeNull();
        expect(stream.allChunksLoaded()).toBe(true);
        expect(stream.length).toBe(10);
      });

      it("has correct data", function () {
        const stream = new ChunkedStreamContinuous(10, 1, null);
        stream.onReceiveData(0, makeRange(10));

        testGetByteRange(stream, 10, 1);
        expect(stream.getByte()).toBe(-1);
        expect(stream.length).toBe(10);
        expect(stream.nextEmptyChunk(0)).toBeNull();

        for (let i = 0; i < 10; i++) {
          expect(stream.hasChunk(i)).toBe(true);
        }
        expect(stream.getByte()).toBe(-1);
        expect(stream.buffer.start).toBe(0);
        expect(stream.buffer.end).toBe(10);
      });
    });

    describe("stream with no data loaded chunked", function () {
      it("reports missing data by throwing an exception", function () {
        const stream = new ChunkedStreamFragmented(10, 1, null);
        expectMissingDataException(function () {
          stream.ensureRange(0, 5);
        }, 0, 5);
      });

      it("reports all data missing", function () {
        const stream = new ChunkedStreamFragmented(10, 1, null);
        expect(stream.length).toBe(10);
        expect(stream.getMissingChunks()).toEqual(makeRange(10, -1));
        expect(stream.isEmpty).toBe(false);
        expect(stream.buffer.start).toBe(-1);
        expect(stream.buffer.end).toBe(-1);
      });
    });

    describe("stream with no data loaded continuous", function () {
      it("reports missing data by throwing an exception", function () {
        const stream = new ChunkedStreamContinuous(10, 1, null);
        expectMissingDataException(function () {
          stream.ensureRange(0, 5);
        }, 0, 5);
      });

      it("reports all data missing", function () {
        const stream = new ChunkedStreamContinuous(10, 1, null);
        expect(stream.length).toBe(10);
        expect(stream.getMissingChunks()).toEqual(makeRange(10, -1));
        expect(stream.isEmpty).toBe(false);
        expect(stream.buffer.start).toBe(0);
        expect(stream.buffer.end).toBe(0);
      });
    });

    describe("receiving chunks and reading data, chunked", function () {
      it("no exceptions", function () {
        const stream = new ChunkedStreamFragmented(10, 1, null);
        stream.onReceiveData(0, new Uint8Array([1]));
        stream.onReceiveData(1, new Uint8Array([2]));
        stream.onReceiveData(2, new Uint8Array([3]));
        stream.onReceiveData(3, new Uint8Array([4, 5]));

        expect(stream.allChunksLoaded()).toBe(false);
        let bytes = stream.getBytes(5);
        expect(bytes).toEqual([1, 2, 3, 4, 5]);

        stream.onReceiveData(5, new Uint8Array([6, 7, 8, 9, 10]));
        expect(stream.allChunksLoaded()).toBe(true);
        expect(stream.length).toBe(10);
        bytes = stream.getBytes(5);
        expect(bytes).toEqual([6, 7, 8, 9, 10]);
        expect(stream.buffer.start).toBe(5);
        expect(stream.buffer.end).toBe(10);
      });
    });

    describe("receiving chunks and reading data, continuous", function () {
      it("no exceptions", function () {
        const stream = new ChunkedStreamContinuous(10, 1, null);
        stream.onReceiveData(0, new Uint8Array([1]));
        stream.onReceiveData(1, new Uint8Array([2]));
        stream.onReceiveData(2, new Uint8Array([3]));
        stream.onReceiveData(3, new Uint8Array([4, 5]));

        expect(stream.allChunksLoaded()).toBe(false);
        let bytes = stream.getBytes(5);
        expect(bytes).toEqual([1, 2, 3, 4, 5]);

        stream.onReceiveData(5, new Uint8Array([6, 7, 8, 9, 10]));
        expect(stream.allChunksLoaded()).toBe(true);
        expect(stream.length).toBe(10);
        bytes = stream.getBytes(5);
        expect(bytes).toEqual([6, 7, 8, 9, 10]);
        expect(stream.buffer.buffer.byteLength).toBe(10);
        // Test if chunks were properly merged
        expect(stream.buffer.start).toBe(0);
        expect(stream.buffer.end).toBe(10);
      });
    });

    describe("receiving chunks out of order continuous", function () {
      it("results in continuous memory and chunk organization", function () {

        const stream = new ChunkedStreamContinuous(10, 1, null);
        stream.onReceiveData(0, new Uint8Array([1]));
        stream.onReceiveData(4, new Uint8Array([5]));
        stream.onReceiveData(2, new Uint8Array([3]));

        expect(stream.loadedChunks[0].start).toBe(0);
        expect(stream.loadedChunks[0].end).toBe(1);
        expect(stream.loadedChunks[4].start).toBe(0);
        expect(stream.loadedChunks[4].end).toBe(5);

        stream.onReceiveData(3, new Uint8Array([4]));
        expect(stream.loadedChunks[3].start).toBe(0);
        expect(stream.loadedChunks[3].end).toBe(5);
        expect(stream.loadedChunks[3].chunkOffset).toBe(3);

        stream.onReceiveData(1, new Uint8Array([2]));
        for (let i = 0; i < 5; i++) {
          expect(stream.loadedChunks[i].start).toBe(0);
          expect(stream.loadedChunks[i].end).toBe(5);
        }

        stream.onReceiveData(5, new Uint8Array([6, 7, 8, 9, 10]));
        testGetByteRange(stream, 10, 1);

        for (let i = 0; i < 10; i++) {
          expect(stream.loadedChunks[i].start).toBe(0);
          expect(stream.loadedChunks[i].end).toBe(10);
        }
      });
    });

    describe("resetting stream", function () {
      let stream;

      beforeEach(function () {
        stream = new ChunkedStreamFragmented(10, 1, null);
        stream.onReceiveData(0, makeRange(10));
        stream.getByte();
        expect(stream.pos).toBe(1);
      });

      it("sets position back to start", function () {
        stream.reset();
        const bytes = stream.getBytes();
        expect(bytes).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      });

      it("reset and skip", function () {
        stream.reset();
        stream.skip(5);
        expect(stream.getBytes()).toEqual([6, 7, 8, 9, 10]);
      });

      it("reset and move start", function () {
        stream.reset();
        stream.skip(5);
        expect(stream.getBytes()).toEqual([6, 7, 8, 9, 10]);
        stream.moveStart();
        expect(stream.getBytes()).toEqual([6, 7, 8, 9, 10]);
        expect(stream.length).toBe(5);
        stream.reset(); // resets back  to moveStart pos
        expect(stream.getBytes()).toEqual([6, 7, 8, 9, 10]);
        expect(stream.length).toBe(5);
      });
    });

    describe("Substreams", function () {
      it("chunked reading", function () {
        const stream = new ChunkedStreamFragmented(100, 1, null);
        expect(stream instanceof ChunkedStreamContinuous).toBe(false);
        stream.onReceiveData(0, makeRange(10));
        for (let i = 10; i < 100; i++) {
          stream.onReceiveData(i, new Uint8Array([i + 1]));
        }

        testGetByteRange(stream, 100, 1);
        expect(stream.getByte()).toBe(-1);

        stream.reset();
        const sub1 = stream.makeSubStream(10, 10);
        const sub2 = stream.makeSubStream(0, 10);
        const sub3 = stream.makeSubStream(20);

        testGetByteRange(sub1, 10, 11);
        expect(sub1.getByte()).toBe(-1);

        testGetByteRange(sub2, 10, 1);
        expect(sub2.getByte()).toBe(-1);

        testGetByteRange(sub3, 80, 21);
        expect(sub3.getByte()).toBe(-1);

        // re-read original stream again
        testGetByteRange(stream, 100, 1);
        expect(stream.getByte()).toBe(-1);
      });

      it("chunked data requests testing ", function () {
        const stream = new ChunkedStreamFragmented(100, 1, null);
        expect(stream instanceof ChunkedStreamContinuous).toBe(false);
        stream.onReceiveData(0, makeRange(10));

        expectMissingDataException(function () {
          stream.makeSubStream(10, 5);
        }, 10, 15);

        // Does not send load request.
        var sub1 = stream.makeSubStream(30);
        expectMissingDataException(function () {
          sub1.getByte();
        }, 30, 31);

        const sub2 = stream.makeSubStream(0, 10);
        const sub3 = sub2.makeSubStream(0, 10);

        // make substreams
        testGetByteRange(sub2, 10, 1);
        expect(sub2.getByte()).toBe(-1);

        testGetByteRange(sub3, 10, 1);
        expect(sub3.getByte()).toBe(-1);

        expectMissingDataException(function () {
          sub2.makeSubStream(1, 13);  // make request
        }, 1, 14);
      });

      it("continuous data requests testing ", function () {
        const stream = new ChunkedStreamContinuous(100, 1, null);
        expect(stream instanceof ChunkedStreamContinuous).toBe(true);
        stream.onReceiveData(0, makeRange(10));

        expectMissingDataException(function () {
          stream.makeSubStream(10, 5);
        }, 10, 15);

        // Does not send load request.
        const sub1 = stream.makeSubStream(30);
        expectMissingDataException(function () {
          sub1.getByte();
        }, 30, 31);

        const sub2 = stream.makeSubStream(0, 10);
        const sub3 = sub2.makeSubStream(0, 10);

        // make substreams
        testGetByteRange(sub2, 10, 1);
        expect(sub2.getByte()).toBe(-1);

        testGetByteRange(sub3, 10, 1);
        expect(sub3.getByte()).toBe(-1);

        expectMissingDataException(function () {
          sub2.makeSubStream(1, 13);  // make request
        }, 1, 14);
      });

      it("chunked getting data", function () {
        const stream = new ChunkedStreamFragmented(100, 1, null);
        expect(stream instanceof ChunkedStreamContinuous).toBe(false);
        expect(stream instanceof ChunkedStreamBase).toBe(true);
        stream.onReceiveData(0, makeRange(10));

        const sub10 = stream.makeSubStream(10);
        const sub20 = stream.makeSubStream(20);
        const sub90 = stream.makeSubStream(90);

        sub10.onReceiveData(10, makeRange(10, 10));
        sub20.onReceiveData(20, makeRange(20, 20));

        // verify stream that has all the data loaded by sub20
        const sub30 = stream.makeSubStream(30, 10);
        testGetByteRange(sub30, 10, 31);
        expect(sub30.getByte()).toBe(-1);

        expect(stream.allChunksLoaded()).toBe(false);

        expect(stream.length).toBe(100);
        expect(sub10.length).toBe(90);
        expect(sub90.length).toBe(10);
        expect(stream.nextEmptyChunk(0)).toBe(40);

        stream.onReceiveData(40, makeRange(20, 40));
        stream.onReceiveData(60, makeRange(20, 60));
        stream.onReceiveData(80, makeRange(20, 80));

        let bytes = stream.getBytes(); // does not advance pos
        expect(bytes).toEqual(makeRange(100));

        bytes = stream.getBytes(10000); //check len
        expect(bytes.byteLength).toBe(100);
        expect(stream.getByte()).toBe(-1); // end reached
      });

      it("continuous getting data", function () {
        const stream = new ChunkedStreamContinuous(100, 1, null);
        expect(stream instanceof ChunkedStreamContinuous).toBe(true);
        expect(stream instanceof ChunkedStreamBase).toBe(true);

        stream.onReceiveData(0, makeRange(10));

        const sub10 = stream.makeSubStream(10);
        const sub20 = stream.makeSubStream(20);
        const sub90 = stream.makeSubStream(90);

        sub10.onReceiveData(10, makeRange(10, 10));
        sub20.onReceiveData(20, makeRange(20, 20));

        // verify stream that has all the data loaded by sub20
        const sub30 = stream.makeSubStream(30, 10);
        testGetByteRange(sub30, 10, 31);
        expect(sub30.getByte()).toBe(-1);

        expect(stream.allChunksLoaded()).toBe(false);

        expect(stream.length).toBe(100);
        expect(sub10.length).toBe(90);
        expect(sub90.length).toBe(10);

        expect(stream.nextEmptyChunk(0)).toBe(40);

        stream.onReceiveData(40, makeRange(20, 40));
        stream.onReceiveData(60, makeRange(20, 60));
        stream.onReceiveData(80, makeRange(20, 80));

        let bytes = stream.getBytes(); // does not advance pos
        expect(bytes).toEqual(makeRange(100));

        bytes = stream.getBytes(10000); //check len
        expect(bytes.byteLength).toBe(100);
        expect(stream.getByte()).toBe(-1); // end reached
      });

      it("chunked substreams getting streaming data", function () {
        const stream = new ChunkedStreamFragmented(80, 7, null);
        expect(stream instanceof ChunkedStreamContinuous).toBe(false);
        stream.onReceiveProgressiveData(makeRange(10));
        stream.onReceiveProgressiveData(makeRange(3, 10));
        stream.onReceiveProgressiveData(makeRange(1, 13));
        stream.onReceiveProgressiveData(makeRange(1, 14));
        stream.onReceiveProgressiveData(makeRange(65, 15));

        const sub7 = stream.makeSubStream(7);
        const sub14 = stream.makeSubStream(14);
        const sub77 = stream.makeSubStream(77);

        expect(stream.getBytes()).toEqual(makeRange(80));

        const sub70at10 = stream.makeSubStream(70, 10);
        expect(sub70at10.getBytes()).toEqual(makeRange(10, 70));

        const fullSub = stream.makeSubStream(0, 80);
        expect(fullSub.getBytes()).toEqual(makeRange(80, 0));
      });

      it("continuous substreams getting streaming data", function () {
        const stream = new ChunkedStreamContinuous(80, 7, null);
        expect(stream instanceof ChunkedStreamContinuous).toBe(true);
        stream.onReceiveProgressiveData(makeRange(10));
        stream.onReceiveProgressiveData(makeRange(3, 10));
        stream.onReceiveProgressiveData(makeRange(1, 13));
        stream.onReceiveProgressiveData(makeRange(1, 14));
        stream.onReceiveProgressiveData(makeRange(65, 15));

        const sub7 = stream.makeSubStream(7);
        const sub14 = stream.makeSubStream(14);
        const sub77 = stream.makeSubStream(77);

        expect(stream.getBytes()).toEqual(makeRange(80));

        const sub70at10 = stream.makeSubStream(70, 10);
        expect(sub70at10.getBytes()).toEqual(makeRange(10, 70));

        const fullSub = stream.makeSubStream(0, 80);
        expect(fullSub.getBytes()).toEqual(makeRange(80, 0));
      });
    });

    describe("Large streams", function () {
      function testProgressiveMode(streamSize, stream) {
        let pos = 0;
        while (pos < streamSize) {
          let dataLen = Math.floor((Math.random() * 100000) + 1);
          if (pos + dataLen > streamSize) {
            dataLen = streamSize - pos;
          }
          stream.onReceiveProgressiveData(makeRange(dataLen, pos));
          pos += dataLen;
        }
        expect(stream.getBytes()).toEqual(makeRange(streamSize));
      }

      function testOffBy1(continuousMode) {
        const streamSizes = [2, 1277, 7703, 103007, 64 * 1024,
          64 * 1024 - 1, 64 * 1024 + 1];
        for (let i = 0; i < streamSizes.length; i++) {
          const streamSize = streamSizes[i];
          const chunkSizes = [64, 65, 63, 33333, streamSize - 1, streamSize,
            streamSize + 1];
          for (var j = 0; j < chunkSizes.length; j++) {
            const chunkSize = chunkSizes[j];
            let stream;
            if (continuousMode) {
              stream = new ChunkedStreamContinuous(streamSize, chunkSize, null);
            } else {
              stream = new ChunkedStreamFragmented(streamSize, chunkSize, null);
            }

            expect(stream instanceof ChunkedStreamContinuous)
              .toBe(continuousMode);
            testProgressiveMode(streamSize, stream);
          }
        }
      }

      it("progressive chunked mode off by 1 testing", function () {
        testOffBy1(false);
      });

      it("progressive continuous mode off by 1 testing", function () {
        testOffBy1(true);
      });
    });
  });
});