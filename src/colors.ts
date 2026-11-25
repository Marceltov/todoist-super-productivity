// Todoist's colour palette (API colour names → hex), so tags look like they do in Todoist.
const TODOIST_COLORS: Record<string, string> = {
  berry_red: '#b8256f', red: '#db4035', orange: '#ff9933', yellow: '#fad000', olive_green: '#afb83b',
  lime_green: '#7ecc49', green: '#299438', mint_green: '#6accbc', teal: '#158fad', sky_blue: '#14aaf5',
  light_blue: '#96c3eb', blue: '#4073ff', grape: '#884dff', violet: '#af38eb', lavender: '#eb96eb',
  magenta: '#e05194', salmon: '#ff8d85', charcoal: '#808080', grey: '#b8b8b8', taupe: '#ccac93',
};

/** Hex for a Todoist colour name; Todoist's default (charcoal) for anything unknown. */
export const todoistHex = (name: string | undefined | null): string =>
  TODOIST_COLORS[name ?? ''] ?? TODOIST_COLORS.charcoal;
