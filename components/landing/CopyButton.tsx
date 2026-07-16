import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./Icon.tsx";

interface CopyButtonProps {
  value: string;
  label: string;
  copiedLabel: string;
  class?: string;
}

/** Copy control with an aria-live acknowledgement and timer cleanup. */
export function CopyButton(
  { value, label, copiedLabel, class: className = "" }: CopyButtonProps,
) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>();

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = globalThis.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard may be unavailable on insecure custom origins. Selection is
      // still possible in the adjacent code block, so this remains non-fatal.
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      class={`copy-button ${className}`}
      onClick={copy}
      aria-label={copied ? copiedLabel : label}
    >
      <Icon name={copied ? "check" : "copy"} size={15} />
      <span aria-live="polite">{copied ? copiedLabel : label}</span>
    </button>
  );
}
