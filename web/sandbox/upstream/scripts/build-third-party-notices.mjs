import { readFile, writeFile } from "node:fs/promises";

const source = await readFile("THIRD_PARTY_NOTICES.md", "utf8");
await writeFile("public/THIRD_PARTY_NOTICES.txt", source, "utf8");
