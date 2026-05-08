import { defineConfig } from 'vite';

/*
 * Build configuration for HACS distribution.
 *
 * The output filename MUST match the GitHub repository name
 * (lowercased) for HACS to find it: repo "Helios" → "helios.js".
 * See https://hacs.xyz/docs/publish/plugin/#requirements
 *
 * The bundle is a single ES module dropped into `dist/`. HACS
 * searches `dist/` first, so this layout is what gets shipped.
 */
export default defineConfig({
    build:
    {
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: false,
        target: 'es2020',
        lib:
        {
            entry:    'src/helios-card.ts',
            formats:  ['es'],
            fileName: () => 'helios.js'
        },
        rollupOptions:
        {
            //Bundle everything (lit, maplibre-gl, ...) into a single
            //file so the user only needs to register one resource URL
            //in Lovelace. No external imports.
            external: []
        },
        //Trim down build output: minify but keep readable enough for
        //the curious user to inspect. Terser preserves classnames so
        //custom-element registrations remain stable across builds.
        minify: 'terser',
        terserOptions:
        {
            keep_classnames: true,
            keep_fnames:     true
        }
    }
});