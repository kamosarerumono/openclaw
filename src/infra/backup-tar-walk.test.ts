import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { walkBackupTar } from "./backup-tar-walk.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, constants: { ...actual.constants, O_NOFOLLOW: 0 } };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it
  .skipIf(process.platform === "win32")
  .each(["readdir", "open", "leaf-open-without-nofollow", "unlinked-leaf-open"] as const)(
  "refuses a source replaced by an external symlink during %s",
  async (operation) => {
    const temp = tempDirs.make("backup-directory-swap-");
    const root = path.join(temp, "source");
    const directory = path.join(root, "changing");
    const outside = path.join(temp, "outside");
    await fs.mkdir(directory, { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(directory, "keep.txt"), "selected bytes");
    await fs.writeFile(path.join(outside, "keep.txt"), "out-of-scope bytes");
    let swapped = false;
    const swap = async () => {
      if (swapped) {
        return;
      }
      await fs.rename(directory, path.join(temp, "retired"));
      await fs.symlink(outside, directory, "dir");
      swapped = true;
    };
    if (operation === "readdir") {
      const readdir = fs.readdir;
      vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
        if (args[0] === directory) {
          await swap();
        }
        return await readdir(...args);
      });
    } else {
      const open = fs.open;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (args[0] === path.join(directory, "keep.txt")) {
          if (operation === "leaf-open-without-nofollow" || operation === "unlinked-leaf-open") {
            const replacement = path.join(temp, "replacement-link");
            await fs.symlink(path.join(outside, "keep.txt"), replacement);
            await fs.rename(replacement, args[0]);
            swapped = true;
            // Windows lacks O_NOFOLLOW; keep a real handle with that open behavior.
            const handle = await open(args[0], "r");
            if (operation === "unlinked-leaf-open") {
              await fs.unlink(args[0]);
            }
            return handle;
          }
          await swap();
        }
        return await open(...args);
      });
    }
    const chunks: Buffer[] = [];
    const archive = async () => {
      for await (const chunk of walkBackupTar({
        tar,
        paths: [root],
        skip: () => false,
        filter: () => true,
        onEntry: (_source, header) => {
          header.path = "payload";
        },
        onVanished: () => {
          throw new Error("unexpected missing entry");
        },
        onProgress: () => {},
      })) {
        chunks.push(chunk);
      }
    };
    await expect(archive()).rejects.toThrow(
      /Backup (directory changed|source became a symbolic link|source identity changed)/u,
    );
    expect(swapped).toBe(true);
    expect(Buffer.concat(chunks).includes(Buffer.from("out-of-scope bytes"))).toBe(false);
  },
);

it("refuses a required root removed during a descendant open", async () => {
  const temp = tempDirs.make("backup-root-removal-");
  const root = path.join(temp, "source");
  await fs.mkdir(root);
  const file = path.join(root, "keep.txt");
  await fs.writeFile(file, "selected bytes");
  const open = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (args[0] === file) {
      await fs.rename(root, path.join(temp, "retired"));
    }
    return await open(...args);
  });
  const onVanished = vi.fn();
  let emittedBytes = 0;
  const archive = async () => {
    for await (const chunk of walkBackupTar({
      tar,
      paths: [root],
      skip: () => false,
      filter: () => true,
      onEntry: (_source, header) => {
        header.path = "payload";
      },
      onVanished,
      onProgress: () => {},
    })) {
      emittedBytes += chunk.length;
    }
  };
  await expect(archive()).rejects.toMatchObject({ code: "ENOENT", path: root });
  expect(onVanished).toHaveBeenCalledWith(file);
  expect(emittedBytes).toBeGreaterThan(0);
});
