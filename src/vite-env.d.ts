//Ambient declarations for Vite's CSS query suffixes used in this
//project. `?inline` returns the stylesheet content as a string
//instead of injecting it as a global <style> tag, used to inline
//MapLibre's CSS into the lit shadow root (see helios-card-css.ts).
declare module '*.css?inline' {
    const css: string;
    export default css;
}
