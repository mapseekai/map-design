import { useId, type ReactNode } from 'react';
import { cn } from '../lib/utils';

export interface MapLoadingProps {
  label: string;
  variant?: 'screen' | 'panel' | 'inline';
  className?: string;
  children?: ReactNode;
}

// Keep the illustration and its styles in the same chunk, including the first-paint fallback.
const loadingStyles = `
.map-loading { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; padding:24px; color:var(--muted-foreground); text-align:center; }
.map-loading[data-variant="screen"] { min-height:100dvh; background:var(--background); gap:16px; }
.map-loading[data-variant="panel"] { min-height:160px; }
.map-loading__art { width:144px; height:108px; flex:none; }
.map-loading[data-variant="screen"] .map-loading__art { width:180px; height:135px; max-width:80vw; }
.map-loading__copy { display:flex; flex-direction:column; gap:8px; }
.map-loading__brand { font-family:var(--serif); font-size:28px; letter-spacing:-.04em; color:var(--foreground); }
.map-loading__label { font-size:13px; line-height:1.6; }
.map-loading__paper { fill:var(--background); stroke:var(--border); stroke-width:1.5; }
.map-loading__district { fill:var(--primary); opacity:.1; }
.map-loading__road { stroke:var(--primary); stroke-width:3; stroke-linecap:round; animation:map-style-color 1.4s ease-in-out -.42s infinite; }
.map-loading__swatch { fill:var(--background); stroke:var(--border); stroke-width:1; }
.map-loading__swatch-primary { fill:var(--primary); }
.map-loading__swatch-muted { fill:var(--muted-foreground); }
.map-loading__swatch-accent { fill:var(--success,var(--primary)); }
.map-loading[data-variant="inline"] { display:inline-flex; flex-direction:row; gap:8px; padding:0; text-align:start; vertical-align:middle; }
.map-loading[data-variant="inline"] .map-loading__art { width:32px; height:24px; }
@keyframes map-style-color { 0%,100% { stroke:var(--primary); } 50% { stroke:var(--success,var(--primary)); } }
@media(prefers-reduced-motion:reduce) { .map-loading__road { animation:none; } }
`;

/** Shared cartographic loading motif. */
export function MapLoading({ label, variant = 'panel', className, children }: MapLoadingProps) {
  const id = useId().replace(/:/g, '');
  return <><style>{loadingStyles}</style><div className={cn('map-loading', className)} data-variant={variant} role="status" aria-live="polite" aria-busy="true">
    <svg className="map-loading__art" viewBox="0 0 240 180" fill="none" aria-hidden="true" focusable="false">
      <defs><clipPath id={id}><rect x="44" y="35" width="140" height="100" rx="10" /></clipPath></defs>
      <rect className="map-loading__paper" x="44" y="35" width="140" height="100" rx="10" />
      <g clipPath={`url(#${id})`}>
        <path className="map-loading__district" d="M44 35H119L103 81 44 98Z" />
        <path className="map-loading__road" d="M39 115C73 113 85 70 113 77S160 91 190 48" />
      </g>
      <rect className="map-loading__swatch" x="126" y="119" width="76" height="27" rx="13.5" />
      <circle className="map-loading__swatch-primary" cx="144" cy="132.5" r="5" />
      <circle className="map-loading__swatch-muted" cx="164" cy="132.5" r="5" />
      <circle className="map-loading__swatch-accent" cx="184" cy="132.5" r="5" />
    </svg>
    <div className="map-loading__copy">
      {variant === 'screen' ? <span className="map-loading__brand" aria-hidden="true">MapDesign</span> : null}
      <span className="map-loading__label">{label}</span>
    </div>
    {children}
  </div></>;
}
