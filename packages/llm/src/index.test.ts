import { describe, it, expect } from "vitest";
import { extractJson } from "./index.js";
import { z } from "zod";

describe("extractJson", () => {
  it("解析裸 JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("解析 markdown 代码块", () => {
    expect(extractJson('说明如下\n```json\n{"a": [1,2]}\n```\n以上')).toEqual({ a: [1, 2] });
  });
  it("解析夹杂文字的 JSON", () => {
    expect(extractJson('好的，这是结果：{"a":"x"} 希望有帮助')).toEqual({ a: "x" });
  });
  it("无法解析返回 undefined", () => {
    expect(extractJson("完全没有 JSON")).toBeUndefined();
  });
});
