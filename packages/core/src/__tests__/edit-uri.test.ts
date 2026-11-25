import { it, expect, describe } from "vitest";

import { fileUriToPath, pathToFileUri } from "../edit/uri.js";

describe("file URIs", () => {
	it("decodes a POSIX URI", () => {
		expect(fileUriToPath("file:///home/me/my%20proj/a.ts")).toBe("/home/me/my proj/a.ts");
	});

	it("decodes a Windows drive URI, with an encoded colon too", () => {
		expect(fileUriToPath("file:///c%3A/proj/src/a.ts")).toBe("c:/proj/src/a.ts");
		expect(fileUriToPath("file:///C:/proj/a.ts")).toBe("C:/proj/a.ts");
	});

	it("decodes a UNC URI", () => {
		expect(fileUriToPath("file://server/share/a.ts")).toBe("//server/share/a.ts");
	});

	it("rejects a URI that is not a file", () => {
		expect(() => fileUriToPath("https://example.com/a.ts")).toThrow("not a file URI");
	});

	it("encodes a POSIX path", () => {
		expect(pathToFileUri("/home/me/my proj/é.ts")).toBe("file:///home/me/my%20proj/%C3%A9.ts");
	});

	it("encodes a Windows path with backslashes and a drive letter", () => {
		expect(pathToFileUri("C:\\proj\\src\\a b.ts")).toBe("file:///C:/proj/src/a%20b.ts");
		expect(pathToFileUri("c:/proj/a.ts")).toBe("file:///c:/proj/a.ts");
	});

	it("encodes a UNC path", () => {
		expect(pathToFileUri("\\\\server\\share\\a.ts")).toBe("file://server/share/a.ts");
	});

	it("round-trips paths through a URI", () => {
		for (const path of ["/tmp/a b/c.ts", "C:/Users/me/proj/a.ts", "//server/share/x.ts"]) {
			expect(fileUriToPath(pathToFileUri(path))).toBe(path);
		}
	});
});
