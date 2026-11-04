// An SVG imported by a gadget module is its text (the bundle's `.svg` loader), not a URL.
declare module "*.svg" {
  const text: string;
  export default text;
}
