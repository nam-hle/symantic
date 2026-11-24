/**
 * `file:` URIs <-> forward-slashed paths, independent of the host platform so a Windows server
 * reply (`file:///c%3A/proj/a.ts`) decodes the same on every machine.
 */

const DRIVE_PATH = /^\/?[A-Za-z]:/;

/** Path of a `file:` URI: forward slashes, drive letter kept, no leading slash before it. */
export function fileUriToPath(uri: string): string {
	if (!uri.startsWith("file://")) {
		throw new Error(`not a file URI: ${uri}`);
	}

	const withoutScheme = uri.slice("file://".length);
	const pathStart = withoutScheme.indexOf("/");
	const host = pathStart === -1 ? withoutScheme : withoutScheme.slice(0, pathStart);
	const decoded = decodeURIComponent(pathStart === -1 ? "/" : withoutScheme.slice(pathStart));

	if (DRIVE_PATH.test(decoded)) {
		return decoded.replace(/^\//, "");
	}

	// `file://server/share/x` is a UNC path on Windows.
	return host === "" ? decoded : `//${host}${decoded}`;
}

/** `file:` URI of an absolute path; backslashes read as separators, a drive letter gets a leading slash. */
export function pathToFileUri(path: string): string {
	const slashed = path.replace(/\\/g, "/");
	const rooted = DRIVE_PATH.test(slashed) ? `/${slashed}` : slashed;
	const encoded = rooted
		.split("/")
		.map((segment, index) => (index === 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
		.join("/");

	// A UNC path (`//server/share`) keeps its host right after the scheme's two slashes.
	return slashed.startsWith("//") ? `file:${encoded}` : `file://${encoded}`;
}
