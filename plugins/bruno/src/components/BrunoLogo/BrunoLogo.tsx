import { useId } from 'react';
import SvgIcon from '@material-ui/core/SvgIcon';
import type { SvgIconProps } from '@material-ui/core/SvgIcon';

/**
 * Cropped to the mark's own ink rather than the 32x28 the asset was exported
 * with. Measured bounds are x[3.22, 28.76] y[3.13, 25.27] for the geometry, plus
 * half of the 0.884 stroke width on every side — so the export left roughly a
 * fifth of its width as dead space on the right and bottom, and the mark landed
 * noticeably smaller than the stock Material-UI icons beside it. The remaining
 * slack is deliberate: the drop shadow (offset 1.69, blurred) needs room below
 * the chin or it clips against the edge.
 */
const VIEW_BOX = '2.5 2.4 27 25.4';

/**
 * The Bruno mark.
 *
 * Wrapped in Material-UI's `SvgIcon` so it behaves exactly like every other
 * icon in the app — `fontSize`, `color` and the icon slots of `Button`,
 * `CardHeader`, `PageLayout` and the auto-discovered sidebar item all work
 * unchanged. The paths carry their own fills, so the brand colours survive
 * `SvgIcon`'s `fill: currentColor`.
 *
 * The drop-shadow filter is referenced by id and the mark renders many times on
 * one page (nav item, card titles, buttons), so the id is minted per instance.
 * `useId`'s colons are stripped: the value lands inside a `url(#…)` fragment
 * reference, which wants a plain identifier.
 */
export function BrunoIcon(props: SvgIconProps): JSX.Element {
  const filterId = `bruno-mark-shadow-${useId().replace(/[^\w-]/g, '')}`;

  return (
    <SvgIcon viewBox={VIEW_BOX} {...props}>
      <g filter={`url(#${filterId})`}>
        <path
          d="M10.8379 4.76457L8.53817 5.64067L5.23502 9.21758L3.36182 13.9713L3.94627 16.389C4.51461 18.1053 5.4564 19.3017 7.14363 20.5769L8.36025 19.4072C8.36025 19.4072 10.0904 22.8975 13.2217 23.4634C13.2217 23.4634 17.8673 24.3399 20.2818 23.0666C20.9563 22.7109 21.4199 22.2385 21.7721 21.8923C22.7094 20.971 23.1452 20.2987 23.8281 19.5203L24.5841 20.3387L25.4162 20.3135L27.6875 17.0407L28.5944 14.7453L28.5846 12.819L27.6006 10.2774L25.4125 6.91973C25.4125 6.91973 24.2188 4.99306 21.7153 5.14657C21.7153 5.14657 18.7727 2.95846 16.3582 3.298C13.9437 3.63753 14.7237 2.99142 10.8379 4.76457Z"
          fill="#F4AA41"
        />
        <path
          d="M16.0565 19.0586L14.6606 20.1527H13.5288L13.7663 21.9135L13.9568 23.2786L14.3211 24.3403L15.6037 25.0194L17.6787 24.7553L18.0678 23.7574L18.3853 21.8659L18.735 20.2281L17.8296 20.3413L16.0565 19.0586Z"
          fill="#EA5A47"
        />
        <path
          d="M14.4719 14.6157L13.7551 16.3134L14.736 16.8793L15.3019 17.1057L17.2637 17.1811L18.5841 16.1625L17.7918 14.6912L14.4719 14.6157Z"
          fill="#3F3F3F"
        />
        <path
          d="M13.1161 11.5327C13.1161 11.5327 12.2989 12.0952 11.8719 11.8351C11.4448 11.575 11.3094 11.0179 11.5695 10.5909C11.8296 10.1638 12.3867 10.0284 12.8137 10.2885C13.2408 10.5486 13.1161 11.5327 13.1161 11.5327Z"
          fill="black"
        />
        <path
          d="M14.7471 14.6553H17.5293C17.7109 14.6553 17.8749 14.7638 17.946 14.9309L18.4702 16.1644L17.4836 16.683C17.2049 16.8295 16.8655 16.6538 16.8241 16.3416"
          fill="none"
          stroke="black"
          strokeWidth="0.884266"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M15.4949 16.3561C15.4436 16.6399 15.1437 16.8041 14.8771 16.6944L13.8298 16.2634L14.3232 14.9489C14.3896 14.7723 14.5584 14.6553 14.7471 14.6553"
          fill="none"
          stroke="black"
          strokeWidth="0.884266"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M13.5372 20.5498C13.5372 20.5498 13.2118 24.5307 14.8986 25.0487C16.0964 25.4165 17.2299 25.2897 17.6432 24.9355C18.0393 24.596 18.8349 22.91 18.4702 20.5498"
          fill="none"
          stroke="black"
          strokeWidth="0.884266"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M19.7972 11.5327C19.7972 11.5327 20.6144 12.0952 21.0415 11.8351C21.4686 11.575 21.6039 11.0179 21.3438 10.5909C21.0838 10.1638 20.5267 10.0284 20.0996 10.2885C19.6725 10.5486 19.7972 11.5327 19.7972 11.5327Z"
          fill="black"
        />
        <path
          d="M11.3591 17.2959C11.144 18.9268 12.3706 19.8992 13.2988 20.3931C13.8406 20.6814 14.4989 20.6277 14.9818 20.2491L16.1503 19.3331L17.3188 20.2491C17.8018 20.6277 18.46 20.6814 19.0018 20.3931C19.93 19.8992 21.1566 18.9268 20.9415 17.2959"
          fill="none"
          stroke="black"
          strokeWidth="0.884266"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M8.79026 10.7398C7.7415 13.0757 8.5601 16.6364 8.84414 17.7007C8.89937 17.9077 8.87832 18.1242 8.7866 18.3178L7.88687 20.2164C7.60483 20.8115 6.80334 20.9196 6.37887 20.416C4.93376 18.7015 2.50435 15.2596 3.41422 12.862C6.61152 4.43674 10.5978 4.64839 10.5978 4.64839C11.8859 3.77302 16.5303 1.50767 21.8308 5.04451C21.8308 5.04451 25.7388 4.26697 28.5932 12.7124C29.4098 15.1282 27.0406 18.5374 25.6277 20.2475C25.2061 20.7577 24.398 20.6522 24.1146 20.0541L23.2209 18.1683C23.1291 17.9747 23.1081 17.7581 23.1633 17.5512C23.4474 16.4869 24.2659 12.9262 23.2172 10.5902"
          fill="none"
          stroke="black"
          strokeWidth="0.884266"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M23.5854 18.9365C23.5854 18.9365 22.1919 21.9795 20.052 22.681"
          fill="none"
          stroke="black"
          strokeWidth="0.884266"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M8.55786 19.1655C8.55786 19.1655 9.95137 21.9191 12.0913 22.6207"
          fill="none"
          stroke="black"
          strokeWidth="0.884266"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M16.1504 19.3332V17.9614"
          fill="none"
          stroke="black"
          strokeWidth="0.884266"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      <defs>
        <filter
          id={filterId}
          x="-1.59387"
          y="0.000111461"
          width="35.1633"
          height="31.7649"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="1.68553" />
          <feGaussianBlur stdDeviation="2.18353" />
          <feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.07 0"
          />
          <feBlend
            mode="normal"
            in2="BackgroundImageFix"
            result="effect1_dropShadow"
          />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2="effect1_dropShadow"
            result="shape"
          />
        </filter>
      </defs>
    </SvgIcon>
  );
}
