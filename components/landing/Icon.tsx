import type { JSX } from "preact";

export type IconName =
  | "arrow"
  | "check"
  | "chevron"
  | "close"
  | "code"
  | "copy"
  | "download"
  | "external"
  | "eye"
  | "eyeOff"
  | "file"
  | "github"
  | "image"
  | "key"
  | "menu"
  | "moon"
  | "play"
  | "send"
  | "stop"
  | "sun"
  | "trash"
  | "upload"
  | "video";

interface IconProps extends JSX.SVGAttributes<SVGSVGElement> {
  name: IconName;
  size?: number;
}

/** Small, dependency-free icon set with consistent square geometry. */
export function Icon({ name, size = 18, ...props }: IconProps) {
  const paths: Record<IconName, JSX.Element> = {
    arrow: (
      <>
        <path d="M5 12h14" />
        <path d="m13 6 6 6-6 6" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m7 10 5 5 5-5" />,
    close: (
      <>
        <path d="m6 6 12 12" />
        <path d="M18 6 6 18" />
      </>
    ),
    code: (
      <>
        <path d="m8 9-3 3 3 3" />
        <path d="m16 9 3 3-3 3" />
        <path d="m14 5-4 14" />
      </>
    ),
    copy: (
      <>
        <rect x="8" y="8" width="11" height="11" />
        <path d="M16 8V5H5v11h3" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12" />
        <path d="m7 10 5 5 5-5" />
        <path d="M5 21h14" />
      </>
    ),
    external: (
      <>
        <path d="M14 4h6v6" />
        <path d="m20 4-9 9" />
        <path d="M18 13v7H4V6h7" />
      </>
    ),
    eye: (
      <>
        <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
        <circle cx="12" cy="12" r="2.5" />
      </>
    ),
    eyeOff: (
      <>
        <path d="m3 3 18 18" />
        <path d="M10.6 6.2A11.5 11.5 0 0 1 12 6c6.5 0 10 6 10 6a18 18 0 0 1-2 2.7" />
        <path d="M6.2 6.2C3.5 8 2 12 2 12s3.5 6 10 6c1.2 0 2.3-.2 3.3-.6" />
      </>
    ),
    file: (
      <>
        <path d="M6 2h8l4 4v16H6Z" />
        <path d="M14 2v5h5" />
      </>
    ),
    github: (
      <path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-2c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 0 1.6 1.1 1.6 1.1.9 1.6 2.4 1.1 3 .8.1-.7.4-1.1.7-1.4-2.2-.3-4.6-1.1-4.6-5A3.9 3.9 0 0 1 7 8.4c-.1-.3-.5-1.3.1-2.8 0 0 .8-.3 2.8 1.1a9.5 9.5 0 0 1 5.1 0c2-1.4 2.8-1.1 2.8-1.1.6 1.5.2 2.5.1 2.8a3.9 3.9 0 0 1 1 2.7c0 3.9-2.4 4.8-4.6 5 .4.3.7 1 .7 2V21c0 .3.2.6.7.5A10 10 0 0 0 12 2Z" />
    ),
    image: (
      <>
        <rect x="3" y="4" width="18" height="16" />
        <circle cx="8.5" cy="9" r="1.5" />
        <path d="m3 17 5-5 4 4 2-2 7 6" />
      </>
    ),
    key: (
      <>
        <circle cx="8" cy="15" r="4" />
        <path d="m11 12 9-9" />
        <path d="m16 7 2 2" />
        <path d="m14 9 2 2" />
      </>
    ),
    menu: (
      <>
        <path d="M4 7h16" />
        <path d="M4 12h16" />
        <path d="M4 17h16" />
      </>
    ),
    moon: <path d="M21 15.5A9 9 0 0 1 8.5 3 9.5 9.5 0 1 0 21 15.5Z" />,
    play: <path d="m8 5 11 7-11 7Z" />,
    send: (
      <>
        <path d="m22 2-7 20-4-9-9-4Z" />
        <path d="M22 2 11 13" />
      </>
    ),
    stop: <rect x="6" y="6" width="12" height="12" />,
    sun: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2" />
        <path d="M12 20v2" />
        <path d="m4.9 4.9 1.4 1.4" />
        <path d="m17.7 17.7 1.4 1.4" />
        <path d="M2 12h2" />
        <path d="M20 12h2" />
        <path d="m4.9 19.1 1.4-1.4" />
        <path d="m17.7 6.3 1.4-1.4" />
      </>
    ),
    trash: (
      <>
        <path d="M4 7h16" />
        <path d="M9 7V4h6v3" />
        <path d="m6 7 1 15h10l1-15" />
        <path d="M10 11v7" />
        <path d="M14 11v7" />
      </>
    ),
    upload: (
      <>
        <path d="M12 16V4" />
        <path d="m7 9 5-5 5 5" />
        <path d="M4 20h16" />
      </>
    ),
    video: (
      <>
        <rect x="3" y="5" width="14" height="14" />
        <path d="m17 10 4-3v10l-4-3" />
      </>
    ),
  };

  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      stroke-linecap="square"
      stroke-linejoin="miter"
      stroke-width="1.75"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
