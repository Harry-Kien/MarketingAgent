import { describe, expect, it } from "vitest";
import { createFakeEmbedder } from "./embed.ts";

describe("createFakeEmbedder", () => {
  it("returns vectors of the configured dimensionality", async () => {
    const embedder = createFakeEmbedder(8);
    const [vector] = await embedder.embed(["san pham demo"]);
    expect(vector).toHaveLength(8);
    expect(embedder.dimensions).toBe(8);
    expect(embedder.name).toBe("fake");
  });

  it("is deterministic: the same text embeds to the identical vector every time", async () => {
    const embedder = createFakeEmbedder(16);
    const [first] = await embedder.embed(["gia san pham la bao nhieu"]);
    const [second] = await embedder.embed(["gia san pham la bao nhieu"]);
    expect(second).toEqual(first);
  });

  it("embeds different texts to different vectors", async () => {
    const embedder = createFakeEmbedder(16);
    const [a, b] = await embedder.embed(["gia san pham", "chinh sach bao hanh"]);
    expect(a).not.toEqual(b);
  });

  it("embeds a batch in the same order as embedding each text alone", async () => {
    const embedder = createFakeEmbedder(4);
    const texts = ["mot", "hai", "ba"];
    const vectors = await embedder.embed(texts);
    const [single0] = await embedder.embed([texts[0]!]);
    const [single1] = await embedder.embed([texts[1]!]);
    expect(vectors).toHaveLength(3);
    expect(vectors[0]).toEqual(single0);
    expect(vectors[1]).toEqual(single1);
  });

  it("throws when dimensions is not a positive number", () => {
    expect(() => createFakeEmbedder(0)).toThrow(/dimensions/);
    expect(() => createFakeEmbedder(-3)).toThrow(/dimensions/);
  });
});
