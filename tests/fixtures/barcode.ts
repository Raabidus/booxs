// EAN-13 test vectors with quiet zones, rendered at four pixels per module.
// This is deliberately independent of the decoder being tested.
export function barcodeBits(isbn: string): string {
  const left = [
    "0001101",
    "0011001",
    "0010011",
    "0111101",
    "0100011",
    "0110001",
    "0101111",
    "0111011",
    "0110111",
    "0001011",
  ];
  const parity = [
    "LLLLLL",
    "LLGLGG",
    "LLGGLG",
    "LLGGGL",
    "LGLLGG",
    "LGGLLG",
    "LGGGLL",
    "LGLGLG",
    "LGLGGL",
    "LGGLGL",
  ];
  const invert = (bits: string) =>
    [...bits].map((bit) => (bit === "0" ? "1" : "0")).join("");
  const first = [...isbn.slice(1, 7)]
    .map((digit, i) =>
      parity[Number(isbn[0])][i] === "L"
        ? left[Number(digit)]
        : invert([...left[Number(digit)]].reverse().join("")),
    )
    .join("");
  const last = [...isbn.slice(7)]
    .map((digit) => invert(left[Number(digit)]))
    .join("");
  return "00000000000" + "101" + first + "01010" + last + "101" + "00000000000";
}

export function barcodePixels(isbn: string) {
  const bits = barcodeBits(isbn);
  const width = bits.length * 4,
    height = 200;
  const pixels = new Uint8ClampedArray(width * height).fill(255);
  for (let y = 20; y < 180; y++)
    for (let x = 0; x < width; x++)
      if (bits[Math.floor(x / 4)] === "1") pixels[y * width + x] = 0;
  return { pixels, width, height };
}
