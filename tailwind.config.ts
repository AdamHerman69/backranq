import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

const config: Config = {
    darkMode: ['class'],
    content: [
        './src/app/**/*.{ts,tsx}',
        './src/components/**/*.{ts,tsx}',
        './src/lib/**/*.{ts,tsx}',
    ],
    theme: {
        container: {
            center: true,
            padding: {
                DEFAULT: '0.75rem',
                sm: '1.25rem',
                lg: '2rem',
            },
            screens: {
                '2xl': '1536px',
            },
        },
        extend: {
            fontFamily: {
                sans: ['var(--font-geist-sans)', 'system-ui', 'sans-serif'],
                display: ['var(--font-newsreader)', 'Georgia', 'serif'],
                mono: ['var(--font-geist-mono)', 'ui-monospace', 'monospace'],
            },
            colors: {
                border: 'hsl(var(--border))',
                input: 'hsl(var(--input))',
                ring: 'hsl(var(--ring))',
                background: 'hsl(var(--background))',
                foreground: 'hsl(var(--foreground))',
                primary: {
                    DEFAULT: 'hsl(var(--primary))',
                    foreground: 'hsl(var(--primary-foreground))',
                },
                secondary: {
                    DEFAULT: 'hsl(var(--secondary))',
                    foreground: 'hsl(var(--secondary-foreground))',
                },
                destructive: {
                    DEFAULT: 'hsl(var(--destructive))',
                    foreground: 'hsl(var(--destructive-foreground))',
                },
                success: {
                    DEFAULT: 'hsl(var(--success))',
                    foreground: 'hsl(var(--success-foreground))',
                },
                warning: {
                    DEFAULT: 'hsl(var(--warning))',
                    foreground: 'hsl(var(--warning-foreground))',
                },
                info: {
                    DEFAULT: 'hsl(var(--info))',
                    foreground: 'hsl(var(--info-foreground))',
                },
                muted: {
                    DEFAULT: 'hsl(var(--muted))',
                    foreground: 'hsl(var(--muted-foreground))',
                },
                accent: {
                    DEFAULT: 'hsl(var(--accent))',
                    foreground: 'hsl(var(--accent-foreground))',
                },
                popover: {
                    DEFAULT: 'hsl(var(--popover))',
                    foreground: 'hsl(var(--popover-foreground))',
                },
                card: {
                    DEFAULT: 'hsl(var(--card))',
                    foreground: 'hsl(var(--card-foreground))',
                },
                surface: {
                    subtle: 'hsl(var(--surface-subtle))',
                    raised: 'hsl(var(--surface-raised))',
                    inset: 'hsl(var(--surface-inset))',
                },
                move: {
                    best: 'hsl(var(--move-best))',
                    strong: 'hsl(var(--move-strong))',
                    good: 'hsl(var(--move-good))',
                    improved: 'hsl(var(--move-improved))',
                    repeated: 'hsl(var(--move-repeated))',
                    different: 'hsl(var(--move-different))',
                },
                board: {
                    light: 'hsl(var(--board-light))',
                    dark: 'hsl(var(--board-dark))',
                    selected: 'hsl(var(--board-selected))',
                    last: 'hsl(var(--board-last-move))',
                },
                analysis: {
                    1: 'hsl(var(--analysis-line-1))',
                    2: 'hsl(var(--analysis-line-2))',
                    3: 'hsl(var(--analysis-line-3))',
                    4: 'hsl(var(--analysis-line-4))',
                    5: 'hsl(var(--analysis-line-5))',
                },
            },
            borderRadius: {
                xs: 'calc(var(--radius-control) - 4px)',
                sm: 'calc(var(--radius-control) - 2px)',
                md: 'var(--radius-control)',
                lg: 'var(--radius-panel)',
                xl: 'var(--radius-feature)',
            },
            boxShadow: {
                control:
                    '0 1px 1px hsl(var(--foreground) / 0.04), 0 1px 3px hsl(var(--foreground) / 0.04)',
                card:
                    '0 1px 2px hsl(var(--foreground) / 0.035), 0 8px 24px -18px hsl(var(--foreground) / 0.22)',
                raised:
                    '0 10px 30px -18px hsl(var(--foreground) / 0.3), 0 2px 8px hsl(var(--foreground) / 0.06)',
                floating:
                    '0 24px 60px -24px hsl(var(--foreground) / 0.38), 0 8px 24px -12px hsl(var(--foreground) / 0.16)',
            },
            transitionDuration: {
                instant: 'var(--duration-instant)',
                fast: 'var(--duration-fast)',
                base: 'var(--duration-base)',
                slow: 'var(--duration-slow)',
            },
            transitionTimingFunction: {
                standard: 'var(--ease-standard)',
                emphasized: 'var(--ease-emphasized)',
            },
            keyframes: {
                'accordion-down': {
                    from: { height: '0' },
                    to: { height: 'var(--radix-accordion-content-height)' },
                },
                'accordion-up': {
                    from: { height: 'var(--radix-accordion-content-height)' },
                    to: { height: '0' },
                },
                shimmer: {
                    '0%': { backgroundPosition: '200% 0' },
                    '100%': { backgroundPosition: '-200% 0' },
                },
                'soft-enter': {
                    from: { opacity: '0', transform: 'translateY(8px)' },
                    to: { opacity: '1', transform: 'translateY(0)' },
                },
                'status-pulse': {
                    '0%, 100%': { opacity: '0.55', transform: 'scale(0.9)' },
                    '50%': { opacity: '1', transform: 'scale(1)' },
                },
            },
            animation: {
                'accordion-down': 'accordion-down 0.2s ease-out',
                'accordion-up': 'accordion-up 0.2s ease-out',
                shimmer: 'shimmer 1.6s ease-in-out infinite',
                'soft-enter':
                    'soft-enter var(--duration-slow) var(--ease-emphasized) both',
                'status-pulse': 'status-pulse 1.4s ease-in-out infinite',
            },
        },
    },
    plugins: [animate],
};

export default config;
