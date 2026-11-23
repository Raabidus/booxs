import { describe, expect, it } from "vitest";
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from "@zxing/library";
import { normalizeIsbn } from "../shared/books";
import { barcodePixels } from "./fixtures/barcode";

describe("the bundled barcode decoder", () => {
  it.each(["9780140328721", "9780804429573"])(
    "decodes the EAN-13 fixture %s",
    (isbn) => {
      const { pixels, width, height } = barcodePixels(isbn);
      const reader = new MultiFormatReader();
      const hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13]);
      const result = reader.decode(
        new BinaryBitmap(
          new HybridBinarizer(new RGBLuminanceSource(pixels, width, height)),
        ),
        hints,
      );
      expect(normalizeIsbn(result.getText())).toBe(isbn);
    },
  );
});
