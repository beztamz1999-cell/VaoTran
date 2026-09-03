export const colors = {
  brand: '#078754', brandStrong: '#075F43', brandSoft: '#EAF7F0',
  canvas: '#EEF2EF', background: '#F7F9F7', surface: '#FFFFFF', section: '#F3F7F4', text: '#17211C', muted: '#6F7B74',
  border: '#E4EAE6', warning: '#F2A43A', warningSoft: '#FFF4DF',
  error: '#E65353', errorSoft: '#FFF0F0', success: '#078754', successSoft: '#E8F8EF',
} as const;

export const space = { xxs: 4, xs: 8, sm: 12, md: 16, lg: 20, xl: 24, xxl: 32 } as const;
export const radius = { input: 12, button: 12, card: 16, hero: 22, pill: 999 } as const;
export const shadow = { shadowColor: '#14231C', shadowOpacity: 0.055, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 1 } as const;
