// Entry point: binds the real PluginAPI. Logic lives in provider.ts (unit-tested).
import type { PluginAPI as PluginAPIType } from '@super-productivity/plugin-api';
import { RefreshCache } from './interval';
import { OccurrenceBook } from './occurrences';
import { createProvider } from './provider';
import { type TagStyle, tagUpdates } from './tag-style';

declare const PluginAPI: PluginAPIType;

const TOKEN_KEY = 'todoistToken';
const INPUT_ID = 'todoist-sync-token';

/** The token goes to SP's device-local secret store, never into the synced provider config. */
const openTokenDialog = async (): Promise<void> => {
  const hasToken = !!(await PluginAPI.getSecret(TOKEN_KEY));
  let entered: string | null = null;
  await PluginAPI.openDialog({
    title: 'Todoist API token',
    htmlContent: `
      <p>${hasToken ? 'A token is saved on this device. Enter a new one to replace it, or leave empty to remove it.' : 'Paste your personal Todoist API token.'}</p>
      <p>Find it in Todoist: <a href="https://app.todoist.com/app/settings/integrations/developer" target="_blank">Settings → Integrations → Developer</a>.</p>
      <input type="password" id="${INPUT_ID}" autocomplete="off" style="width:100%;padding:8px" placeholder="API token">
      <p style="opacity:.7">Stored only on this device. It is not synced or exported.</p>`,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Save',
        color: 'primary',
        raised: true,
        onClick: () => {
          entered = (document.getElementById(INPUT_ID) as HTMLInputElement | null)?.value.trim() ?? null;
        },
      },
    ],
  });
  if (entered === null) return;
  if (entered) {
    await PluginAPI.setSecret(TOKEN_KEY, entered);
    PluginAPI.showSnack({ msg: 'Todoist token saved', type: 'SUCCESS' });
  } else {
    await PluginAPI.deleteSecret(TOKEN_KEY);
    PluginAPI.showSnack({ msg: 'Todoist token removed', type: 'INFO' });
  }
};

/** Gives tags of Todoist projects/labels their Todoist colour and icon. Runs one at a time; failures are harmless. */
let styling = Promise.resolve();
const applyTagStyles = (styles: TagStyle[]): void => {
  styling = styling
    .then(async () => {
      for (const { id, updates } of tagUpdates(await PluginAPI.getAllTags(), styles)) {
        await PluginAPI.updateTag(id, updates);
      }
    })
    .catch((e) => console.warn('[todoist-sync] tag styling failed', e));
};

const main = async (): Promise<void> => {
  const book = await OccurrenceBook.load({
    load: () => PluginAPI.loadSyncedData('occurrences'),
    save: (data) => PluginAPI.persistDataSynced(data, 'occurrences'),
  });
  PluginAPI.registerIssueProvider(
    createProvider({
      getToken: () => PluginAPI.getSecret(TOKEN_KEY),
      book,
      cache: new RefreshCache(),
      onTagStyles: applyTagStyles,
    }),
  );
  PluginAPI.registerConfigHandler(() => void openTokenDialog());
};

void main();
