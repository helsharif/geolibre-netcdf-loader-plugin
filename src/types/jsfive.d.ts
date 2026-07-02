declare module "jsfive" {
  export class File {
    keys?: string[];
    constructor(data: ArrayBuffer, filename?: string);
    get(path: string): unknown;
  }
}
