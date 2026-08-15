/**
 * Speaker glyph. ui-primitives ships no volume icon; this mirrors its 16px
 * outline style (currentColor, 16×16 viewBox) so the action strip reads as
 * one row.
 */
export function IconSpeakerOutline16({ size = 16, className }: {
  size?: number
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M2 6v4h2.7L8 13.3V2.7L4.7 6H2Z"
        fill="currentColor"
      />
      <path
        d="M11 8c0-1.18-.68-2.19-1.67-2.69v5.38C10.32 10.19 11 9.18 11 8Z"
        fill="currentColor"
      />
      <path
        d="M9.33 2.15v1.38c1.93.57 3.34 2.36 3.34 4.47s-1.41 3.9-3.34 4.47v1.38c2.68-.61 4.67-3 4.67-5.85s-1.99-5.24-4.67-5.85Z"
        fill="currentColor"
      />
    </svg>
  )
}
