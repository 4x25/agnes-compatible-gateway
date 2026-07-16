interface BrandMarkProps {
  class?: string;
}

/** Gateway monogram used in the header and footer. */
export function BrandMark({ class: className = "" }: BrandMarkProps) {
  return (
    <span class={`brand-mark ${className}`} aria-hidden="true">
      <svg viewBox="0 0 32 32" role="img">
        <path d="M3 4h13v7H10v10h6v7H3V4Z" fill="currentColor" />
        <path d="M17 4h12v24H17v-7h5V11h-5V4Z" fill="var(--accent)" />
        <path d="m13 13 6 3-6 3v-6Z" fill="var(--canvas)" />
      </svg>
    </span>
  );
}
