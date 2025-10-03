import * as Bluebird from 'bluebird';
const Promise = Bluebird;

import * as path from 'path';
import * as fs from 'fs-extra';

import { log, types } from 'vortex-api';

const STORE_ID = 'gog';
const STORE_NAME = 'GOG';
// no DRM, does it get better than this?
const STORE_PRIORITY = 15;

const GOG_EXEC = 'GalaxyClient.exe';
const GOG_MAC_EXEC = 'GOG Galaxy.app';

const REG_GOG_GAMES = 'SOFTWARE\\WOW6432Node\\GOG.com\\Games';

/**
 * base class to interact with local GoG Galaxy client
 * @class GoGLauncher
 */
export class GoGLauncher implements types.IGameStore {
  public id: string = STORE_ID;
  public name: string = STORE_NAME;
  public priority: number = STORE_PRIORITY;
  private mClientPath: Promise<string>;
  private mCache: Promise<types.IGameStoreEntry[]>;

  constructor() {
    if (process.platform === 'win32') {
      // Windows implementation
      try {
        // We need to dynamically import winapi only on Windows
        import('winapi-bindings').then((winapi) => {
          const gogPath = winapi.RegGetValue('HKEY_LOCAL_MACHINE',
            'SOFTWARE\\WOW6432Node\\GOG.com\\GalaxyClient\\paths', 'client');
          this.mClientPath = Promise.resolve(gogPath.value as string);
        }).catch((err) => {
          log('info', 'gog not found', { error: err.message });
          this.mClientPath = undefined;
        });
      } catch (err) {
        log('info', 'gog not found', { error: err.message });
        this.mClientPath = undefined;
      }
    } else if (process.platform === 'darwin') {
      // macOS implementation: detect synchronously and degrade gracefully if not installed
      const standardPath = '/Applications/GOG Galaxy.app';
      const userAppsPath = path.join(process.env.HOME || '', 'Applications', 'GOG Galaxy.app');
      try {
        if (fs.existsSync(standardPath)) {
          this.mClientPath = Promise.resolve(standardPath);
        } else if (fs.existsSync(userAppsPath)) {
          this.mClientPath = Promise.resolve(userAppsPath);
        } else {
          log('info', 'gog not found', { error: 'macOS app not installed' });
          this.mClientPath = undefined;
        }
      } catch (err) {
        log('info', 'gog not found', { error: err.message });
        this.mClientPath = undefined;
      }
    } else {
      log('info', 'gog not found', { error: 'unsupported platform' });
      this.mClientPath = undefined;
    }
  }

  /**
   * Find GOG Galaxy on macOS
   */
  private async findMacOSGOGPath(): Promise<string> {
    // Check standard installation path
    const standardPath = '/Applications/GOG Galaxy.app';
    try {
      const stat = await fs.stat(standardPath);
      if (stat.isDirectory()) {
        return Promise.resolve(standardPath);
      }
    } catch (err) {
      // Continue to next check
    }

    // Check in user's Applications directory
    const userAppsPath = path.join(process.env.HOME || '', 'Applications', 'GOG Galaxy.app');
    try {
      const stat = await fs.stat(userAppsPath);
      if (stat.isDirectory()) {
        return Promise.resolve(userAppsPath);
      }
    } catch (err) {
      // Not found
    }

    return Promise.reject(new Error('GOG Galaxy not found on macOS'));
  }

  /**
   * find the first game that matches the specified name pattern
   */
  public findByName(namePattern: string): Promise<types.IGameStoreEntry> {
    const re = new RegExp('^' + namePattern + '$');
    return this.allGames()
      .then(entries => entries.find(entry => re.test(entry.name)))
      .then(entry => {
        if (entry === undefined) {
          return Promise.reject(new types.GameEntryNotFound(namePattern, STORE_ID));
        } else {
          return Promise.resolve(entry);
        }
      });
  }

  public launchGame(appInfo: any, api?: types.IExtensionApi): Promise<void> {
    return this.getExecInfo(appInfo)
      .then(execInfo =>
        api.runExecutable(execInfo.execPath, execInfo.arguments, {
          cwd: path.dirname(execInfo.execPath),
          suggestDeploy: true,
          shell: true,
        }));
  }

  public getExecInfo(appId: string): Promise<types.IExecInfo> {
    return this.allGames()
      .then(entries => {
        const gameEntry = entries.find(entry => entry.appid === appId);
        return (gameEntry === undefined)
          ? Promise.reject(new types.GameEntryNotFound(appId, STORE_ID))
          : (!this.mClientPath
              ? Promise.reject(new Error('GOG Galaxy not installed'))
              : this.mClientPath.then((basePath) => {
              if (process.platform === 'darwin') {
                // On macOS, we launch the app bundle directly
                const gogClientExec = {
                  execPath: basePath,
                  arguments: [`/gameId=${gameEntry.appid}`, '/command=runGame', `path="${gameEntry.gamePath}"`],
                };
                return Promise.resolve(gogClientExec);
              } else {
                // Windows implementation
                const gogClientExec = {
                  execPath: path.join(basePath, GOG_EXEC),
                  arguments: ['/command=runGame',
                              `/gameId=${gameEntry.appid}`,
                              `path="${gameEntry.gamePath}"`],
                };
                return Promise.resolve(gogClientExec);
              }
            }));
      });
  }

  /**
   * find the first game with the specified appid or one of the specified appids
   */
  public findByAppId(appId: string | string[]): Promise<types.IGameStoreEntry> {
    const matcher = Array.isArray(appId)
      ? (entry: types.IGameStoreEntry) => (appId.includes(entry.appid))
      : (entry: types.IGameStoreEntry) => (appId === entry.appid);

    return this.allGames()
      .then(entries => {
        const gameEntry = entries.find(matcher);
        if (gameEntry === undefined) {
          return Promise.reject(
            new types.GameEntryNotFound(Array.isArray(appId) ? appId.join(', ') : appId, STORE_ID));
        } else {
          return Promise.resolve(gameEntry);
        }
      });
  }

  public allGames(): Promise<types.IGameStoreEntry[]> {
    if (!this.mCache) {
      this.mCache = this.getGameEntries();
    }
    return this.mCache;
  }

  public reloadGames(): Promise<void> {
    return new Promise((resolve) => {
      this.mCache = this.getGameEntries();
      return resolve();
    });
  }

  public getGameStorePath(): Promise<string> {
    return (!!this.mClientPath)
      ? this.mClientPath.then(basePath => {
          if (process.platform === 'darwin') {
            return Promise.resolve(basePath);
          } else {
            return Promise.resolve(path.join(basePath, 'GalaxyClient.exe'));
          }
        })
      : Promise.resolve(undefined);
  }

  public identifyGame(gamePath: string,
                      fallback: (gamePath: string) => PromiseLike<boolean>)
                      : Promise<boolean> {
    return Promise.all([this.fileExists(path.join(gamePath, 'gog.ico')), fallback(gamePath)])
      .then(([custom, fallback]) => {
        if (custom !== fallback) {
          log('warn', '(gog) game identification inconclusive', {
            gamePath,
            custom,
            fallback,
          });
        }
        return custom || fallback;
      });
  }

  private fileExists(filePath: string): PromiseLike<boolean> {
    return fs.stat(filePath)
      .then(() => true)
      .catch(() => false);
  }

  private getGameEntries(): Promise<types.IGameStoreEntry[]> {
    if (process.platform === 'win32') {
      // Windows implementation using registry
      return this.getGameEntriesWindows();
    } else if (process.platform === 'darwin') {
      // macOS implementation
      return this.getGameEntriesMacOS();
    } else {
      return Promise.resolve([]);
    }
  }

  private getGameEntriesWindows(): Promise<types.IGameStoreEntry[]> {
    return (!!this.mClientPath)
      ? import('winapi-bindings').then((winapi) => {
        return new Promise<types.IGameStoreEntry[]>((resolve, reject) => {
          try {
            winapi.WithRegOpen('HKEY_LOCAL_MACHINE', REG_GOG_GAMES, hkey => {
              const keys = winapi.RegEnumKeys(hkey);
              const gameEntries: types.IGameStoreEntry[] = keys.map(key => {
                try {
                  const gameEntry: types.IGameStoreEntry = {
                    appid: winapi.RegGetValue(hkey, key.key, 'gameID').value as string,
                    gamePath: winapi.RegGetValue(hkey, key.key, 'path').value as string,
                    name: winapi.RegGetValue(hkey, key.key, 'startMenu').value as string,
                    gameStoreId: STORE_ID,
                  };
                  return gameEntry;
                } catch (err) {
                  log('error', 'gamestore-gog: failed to create game entry', err);
                  // Don't stop, keep going.
                  return undefined;
                }
              }).filter(entry => !!entry);
              return resolve(gameEntries);
            });
          } catch (err) {
            return (err.code === 'ENOENT') ? resolve([]) : reject(err);
          }
        });
      }).catch(() => Promise.resolve([]))
      : Promise.resolve([]);
  }

  private async getGameEntriesMacOS(): Promise<types.IGameStoreEntry[]> {
    try {
      // On macOS, we need to look for game info in the GOG Galaxy data directory
      const homeDir = process.env.HOME || '';
      const gogDataPath = path.join(homeDir, 'Library', 'Application Support', 'GOG.com', 'Galaxy');
      
      // Check if the GOG Galaxy data directory exists
      try {
        await fs.stat(gogDataPath);
      } catch (err) {
        // GOG Galaxy data directory not found
        return [];
      }
      
      // Look for game information in the games directory
      const gamesPath = path.join(gogDataPath, 'games');
      let gameDirs: string[] = [];
      
      try {
        gameDirs = await fs.readdir(gamesPath);
      } catch (err) {
        // Games directory not found
        return [];
      }
      
      const gameEntries: types.IGameStoreEntry[] = [];
      
      // Process each game directory
      for (const gameId of gameDirs) {
        try {
          const gameInfoPath = path.join(gamesPath, gameId, 'gameinfo');
          const gameInfoData = await fs.readFile(gameInfoPath, 'utf8');
          
          try {
            const gameInfo = JSON.parse(gameInfoData);
            const appid = gameInfo.gameId || gameId;
            const name = gameInfo.name || gameInfo.title || `GOG Game ${appid}`;
            const gamePath = gameInfo.installDirectory;
            
            // Only add games with valid paths
            if (gamePath) {
              try {
                await fs.stat(gamePath);
                gameEntries.push({
                  appid,
                  name,
                  gamePath,
                  gameStoreId: STORE_ID,
                });
              } catch (err) {
                // Game directory doesn't exist, skip this game
                log('debug', 'GOG game directory not found', { gamePath });
              }
            }
          } catch (parseErr) {
            log('error', 'Failed to parse GOG game info', { gameId, error: parseErr.message });
          }
        } catch (err) {
          // Failed to read game info file
          log('debug', 'Failed to read GOG game info file', { gameId, error: err.message });
        }
      }
      
      return gameEntries;
    } catch (err) {
      log('error', 'Failed to get GOG games on macOS', { error: err.message });
      return [];
    }
  }
}

function main(context: types.IExtensionContext) {
  const instance: types.IGameStore = new GoGLauncher();

  if (instance !== undefined) {
    context.registerGameStore(instance);
  }

  return true;
}

export default main;