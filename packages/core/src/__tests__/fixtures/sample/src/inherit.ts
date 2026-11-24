// Heritage shapes for findImplementations: class extends, interface extends, and object
// literals typed by annotation or `satisfies`.
export abstract class Base {
	abstract run(): void;
}

export class Derived extends Base {
	run(): void {}
}

export interface Named {
	name: string;
}

export interface Titled extends Named {
	title: string;
}

export const annotated: Named = { name: "a" };

export const checked = { name: "b" } satisfies Named;
