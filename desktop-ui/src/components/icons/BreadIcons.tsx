import React from 'react'

export type BreadAppIconName =
  | 'consult'
  | 'creation'
  | 'tasks'
  | 'memory'
  | 'capture'
  | 'profile'
  | 'models'
  | 'privacy'
  | 'monitor'
  | 'settings'

export type BreadToolIconName =
  | 'copy'
  | 'stop'
  | 'clear'
  | 'retry'
  | 'attach'
  | 'send'

type BreadIconName = BreadAppIconName | BreadToolIconName

type BreadIconProps = Omit<React.SVGProps<SVGSVGElement>, 'name'> & {
  name: BreadIconName
  size?: number
  framed?: boolean
}

const GlassFrame = () => (
  <>
    <rect
      x="3.4"
      y="3.4"
      width="17.2"
      height="17.2"
      rx="5.1"
      fill="var(--bread-icon-fill, rgba(255, 250, 240, 0.72))"
      stroke="var(--bread-icon-glass-edge, rgba(124, 78, 37, 0.24))"
      strokeWidth="0.9"
    />
    <path
      d="M5.85 7.05c1.95-1.28 4.62-1.88 8.02-1.78 1.44.04 2.78.22 4.02.54"
      fill="none"
      stroke="var(--bread-icon-glass-highlight, rgba(255, 255, 255, 0.78))"
      strokeLinecap="round"
      strokeWidth="0.8"
    />
    <rect
      x="4.55"
      y="4.55"
      width="14.9"
      height="14.9"
      rx="4.3"
      fill="none"
      stroke="var(--bread-icon-inner, rgba(255, 255, 255, 0.36))"
      strokeWidth="0.7"
    />
  </>
)

const renderGlyph = (name: BreadIconName) => {
  switch (name) {
    case 'consult':
      return (
        <>
          <path d="M7.7 10.45c0-1.7 1.35-2.95 3.1-2.95h2.55c1.75 0 3.05 1.25 3.05 2.95v1.2c0 1.62-1.3 2.82-3.05 2.82h-1.9l-2.45 1.8.45-1.94c-1.05-.42-1.75-1.42-1.75-2.68v-1.2Z" />
          <circle cx="10.05" cy="11.25" r="0.48" fill="var(--bread-icon-accent, #d98c38)" stroke="none" />
          <circle cx="12.05" cy="11.25" r="0.48" fill="var(--bread-icon-accent, #d98c38)" stroke="none" />
          <circle cx="14.05" cy="11.25" r="0.48" fill="var(--bread-icon-accent, #d98c38)" stroke="none" />
        </>
      )
    case 'creation':
      return (
        <>
          <path d="m8.15 15.85.7-2.75 5.55-5.55c.5-.5 1.3-.5 1.8 0l.25.25c.5.5.5 1.3 0 1.8l-5.55 5.55-2.75.7Z" />
          <path d="m13.65 8.3 2.05 2.05" />
          <path d="M8.2 17.25h7.45" />
        </>
      )
    case 'tasks':
      return (
        <>
          <circle cx="12" cy="12" r="4.15" />
          <path d="M12 9.55v2.85l1.85 1.02" />
          <path d="M8.8 7.25h6.4" />
          <path d="M9.15 16.7h5.7" />
        </>
      )
    case 'memory':
      return (
        <>
          <path d="M8.45 15.95h7.1" />
          <path d="M9.05 8.05h1.8v7.9h-1.8z" />
          <path d="M11.55 8.6h1.8v7.35h-1.8z" />
          <path d="m14.05 9.05 1.75-.25.95 6.95-1.75.25-.95-6.95Z" />
          <path d="M9.45 10.2h1" />
          <path d="M11.95 10.75h1" />
        </>
      )
    case 'capture':
      return (
        <>
          <path d="M7.6 10.2h3.35l.9 1h4.55v4.9c0 .55-.45 1-1 1H8.6c-.55 0-1-.45-1-1v-5.9Z" />
          <path d="M9.15 13.2h5.7" />
          <path d="M10.55 15.25h2.9" />
        </>
      )
    case 'profile':
      return (
        <>
          <circle cx="12" cy="10.1" r="2.05" />
          <path d="M8.15 16.45c.46-1.86 1.78-2.78 3.85-2.78s3.39.92 3.85 2.78" />
        </>
      )
    case 'models':
      return (
        <>
          <rect x="8.55" y="8.55" width="6.9" height="6.9" rx="1.35" />
          <rect x="10.65" y="10.65" width="2.7" height="2.7" rx="0.55" fill="var(--bread-icon-accent, #d98c38)" opacity="0.42" />
          <path d="M10 6.9v1.25M14 6.9v1.25M10 15.85v1.25M14 15.85v1.25M6.9 10h1.25M6.9 14h1.25M15.85 10h1.25M15.85 14h1.25" />
        </>
      )
    case 'privacy':
      return (
        <>
          <path d="M12 7.25 16.1 8.8v3.1c0 2.55-1.55 4.28-4.1 5.35-2.55-1.07-4.1-2.8-4.1-5.35V8.8L12 7.25Z" />
          <path d="m10.15 12.25 1.35 1.35 2.65-2.8" />
        </>
      )
    case 'monitor':
      return (
        <>
          <path d="M7.4 16.7h9.2" />
          <rect x="8" y="12.7" width="1.85" height="3.25" rx="0.55" fill="var(--bread-icon-accent, #d98c38)" opacity="0.64" />
          <rect x="11.1" y="10.2" width="1.85" height="5.75" rx="0.55" fill="var(--bread-icon-accent, #d98c38)" opacity="0.82" />
          <rect x="14.2" y="8.15" width="1.85" height="7.8" rx="0.55" fill="var(--bread-icon-accent, #d98c38)" />
        </>
      )
    case 'settings':
      return (
        <>
          <circle cx="12" cy="12" r="2.15" />
          <path d="M12 7.1v1.25M12 15.65v1.25M7.1 12h1.25M15.65 12h1.25M8.55 8.55l.9.9M14.55 14.55l.9.9M15.45 8.55l-.9.9M9.45 14.55l-.9.9" />
        </>
      )
    case 'copy':
      return (
        <>
          <rect x="8.2" y="9.15" width="6.65" height="6.65" rx="1.2" />
          <path d="M10.25 7.25h4.6c.95 0 1.7.75 1.7 1.7v4.6" />
        </>
      )
    case 'stop':
      return <rect x="8.75" y="8.75" width="6.5" height="6.5" rx="1.28" fill="var(--bread-icon-accent, #d98c38)" />
    case 'clear':
      return (
        <>
          <path d="M8.75 9.3h6.5" />
          <path d="M10.05 9.3v6.8c0 .56.44 1 1 1h1.9c.56 0 1-.44 1-1V9.3" />
          <path d="M10.9 9.3v-1c0-.48.38-.86.86-.86h.48c.48 0 .86.38.86.86v1" />
          <path d="M11.35 11.2v3.7M12.65 11.2v3.7" />
        </>
      )
    case 'retry':
      return (
        <>
          <path d="M15.7 9.6a4.2 4.2 0 1 0 .08 4.7" />
          <path d="M15.88 7.65v2.55h-2.55" />
        </>
      )
    case 'attach':
      return <path d="m9.05 12.6 3.88-3.88a2.1 2.1 0 0 1 2.97 2.97l-4.35 4.35a2.9 2.9 0 0 1-4.1-4.1l4.45-4.45" />
    case 'send':
      return (
        <>
          <path d="m7.6 8.2 9.15 3.8-9.15 3.8 2.38-3.8-2.38-3.8Z" />
          <path d="M9.98 12h4.12" />
        </>
      )
    default:
      return null
  }
}

const BreadIconBase = ({
  name,
  size = 24,
  framed = true,
  className = '',
  ...svgProps
}: BreadIconProps) => (
  <svg
    {...svgProps}
    className={`bread-icon ${framed ? 'bread-icon--framed' : 'bread-icon--plain'} ${className}`.trim()}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
    focusable="false"
  >
    {framed && <GlassFrame />}
    <g
      stroke="var(--bread-icon-line, currentColor)"
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    >
      {renderGlyph(name)}
    </g>
  </svg>
)

export const BreadAppIcon = (props: Omit<BreadIconProps, 'name'> & { name: BreadAppIconName }) => (
  <BreadIconBase {...props} framed={props.framed ?? true} className={`bread-icon--app ${props.className ?? ''}`.trim()} />
)

export const BreadToolIcon = (props: Omit<BreadIconProps, 'name'> & { name: BreadToolIconName }) => (
  <BreadIconBase {...props} framed={props.framed ?? false} className={`bread-icon--tool ${props.className ?? ''}`.trim()} />
)
