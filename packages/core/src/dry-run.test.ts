import { describe, expect, test } from "vitest";
import { parseConflictHunks } from "./dry-run.js";

describe("parseConflictHunks", () => {
  test("reads both sides of each conflict", () => {
    const text = [
      "a",
      "<<<<<<< HEAD",
      "mine",
      "=======",
      "theirs 1",
      "theirs 2",
      ">>>>>>> origin/main",
      "b",
      "<<<<<<< 1234abc",
      "=======",
      "only theirs",
      ">>>>>>> 5678def",
    ].join("\n");
    expect(parseConflictHunks(text)).toEqual([
      { yours: ["mine"], theirs: ["theirs 1", "theirs 2"] },
      { yours: [], theirs: ["only theirs"] },
    ]);
  });

  test("skips the original lines in diff3 style", () => {
    const text = "<<<<<<< ours\nmine\n||||||| base\noriginal\n=======\ntheirs\n>>>>>>> theirs\n";
    expect(parseConflictHunks(text)).toEqual([{ yours: ["mine"], theirs: ["theirs"] }]);
  });

  test("no markers, no hunks", () => {
    expect(parseConflictHunks("plain file\n")).toEqual([]);
  });
});
