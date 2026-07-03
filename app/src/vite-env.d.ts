/// <reference types="vite/client" />

// Build stamp injected by vite.config.ts `define` (short git hash + date).
declare const __FLOCK_BUILD__: string
declare const __FLOCK_BUILT_AT__: string

declare module '*.css'
declare module 'maplibre-gl/dist/maplibre-gl.css'
declare module '@fontsource-variable/fraunces'
declare module '@fontsource-variable/hanken-grotesk'
declare module 'qrcode-generator'
