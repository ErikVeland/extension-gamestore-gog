import * as path from 'path';
import * as fs from 'fs-extra';

import { log, types } from 'vortex-api';
import Bluebird = require('bluebird');

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
  private mClientPath: Bluebird<string> | undefined;
  private mCache: Bluebird<types.IGameStoreEntry[]> | undefined;

  constructor() {
    if (process.platform === 'win32') {
      // Windows implementation
      try {
        // We need to dynamically import winapi only on Windows
        import('winapi-bindings').then((winapi) => {
          const gogPath = winapi.RegGetValue('HKEY_LOCAL_MACHINE',
            'SOFTWARE\\WOW6432Node\\GOG.com\\GalaxyClient\\paths', 'client');
          this.mClientPath = Bluebird.resolve(gogPath.value as string);
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
          this.mClientPath = Bluebird.resolve(standardPath);
        } else if (fs.existsSync(userAppsPath)) {
          this.mClientPath = Bluebird.resolve(userAppsPath);
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
  private findMacOSGOGPath(): Bluebird<string> {
    // Check standard installation path
    const standardPath = '/Applications/GOG Galaxy.app';
    return Bluebird.resolve(fs.stat(standardPath))
      .then(stat => (stat.isDirectory() ? Bluebird.resolve(standardPath) : Bluebird.reject(new Error('not found'))))
      .catch(() => {
        const userAppsPath = path.join(process.env.HOME || '', 'Applications', 'GOG Galaxy.app');
        return Bluebird.resolve(fs.stat(userAppsPath))
          .then(stat => (stat.isDirectory() ? Bluebird.resolve(userAppsPath) : Bluebird.reject(new Error('not found'))));
      })
      .catch(() => Bluebird.reject(new Error('GOG Galaxy not found on macOS')));
  }

  /**
   * find the first game that matches the specified name pattern
   */
  public findByName(namePattern: string): Bluebird<types.IGameStoreEntry> {
    const re = new RegExp('^' + namePattern + '$');
    return this.allGames()
      .then(entries => entries.find(entry => re.test(entry.name)))
      .then(entry => {
        if (entry === undefined) {
          return Bluebird.reject(new types.GameEntryNotFound(namePattern, STORE_ID));
        } else {
          return Bluebird.resolve(entry);
        }
      });
  }

  public launchGame(appInfo: any, api?: types.IExtensionApi): Bluebird<void> {
    return this.getExecInfo(appInfo)
      .then(execInfo =>
        api.runExecutable(execInfo.execPath, execInfo.arguments, {
          cwd: path.dirname(execInfo.execPath),
          suggestDeploy: true,
          shell: true,
        }));
  }

  public getExecInfo(appId: string): Bluebird<types.IExecInfo> {
    return this.allGames()
      .then(entries => {
        const gameEntry = entries.find(entry => entry.appid === appId);
        return (gameEntry === undefined)
          ? Bluebird.reject(new types.GameEntryNotFound(appId, STORE_ID))
          : (!this.mClientPath
              ? Bluebird.reject(new Error('GOG Galaxy not installed'))
              : this.mClientPath.then((basePath) => {
              if (process.platform === 'darwin') {
                // On macOS, we launch the app bundle directly
                const gogClientExec = {
                  execPath: basePath,
                  arguments: [`/gameId=${gameEntry.appid}`, '/command=runGame', `path="${gameEntry.gamePath}"`],
                };
                return Bluebird.resolve(gogClientExec);
              } else {
                // Windows implementation
                const gogClientExec = {
                  execPath: path.join(basePath, GOG_EXEC),
                  arguments: ['/command=runGame',
                              `/gameId=${gameEntry.appid}`,
                              `path="${gameEntry.gamePath}"`],
                };
                return Bluebird.resolve(gogClientExec);
              }
            }));
      });
  }

  /**
   * find the first game with the specified appid or one of the specified appids
   */
  public findByAppId(appId: string | string[]): Bluebird<types.IGameStoreEntry> {
    const matcher = Array.isArray(appId)
      ? (entry: types.IGameStoreEntry) => (appId.includes(entry.appid))
      : (entry: types.IGameStoreEntry) => (appId === entry.appid);

    return this.allGames()
      .then(entries => {
        const gameEntry = entries.find(matcher);
        if (gameEntry === undefined) {
          return Bluebird.reject(
            new types.GameEntryNotFound(Array.isArray(appId) ? appId.join(', ') : appId, STORE_ID));
        } else {
          return Bluebird.resolve(gameEntry);
        }
      });
  }

  public allGames(): Bluebird<types.IGameStoreEntry[]> {
    if (!this.mCache) {
      this.mCache = this.getGameEntries();
    }
    return this.mCache;
  }

  public reloadGames(): Bluebird<void> {
    return new Bluebird((resolve) => {
      this.mCache = this.getGameEntries();
      return resolve();
    });
  }

  public getGameStorePath(): Bluebird<string> {
    return (!!this.mClientPath)
      ? this.mClientPath.then(basePath => {
          if (process.platform === 'darwin') {
            return Bluebird.resolve(basePath);
          } else {
            return Bluebird.resolve(path.join(basePath, 'GalaxyClient.exe'));
          }
        })
      : Bluebird.resolve(undefined);
  }

  public identifyGame(gamePath: string,
                      fallback: (gamePath: string) => PromiseLike<boolean>)
                      : Bluebird<boolean> {
    return Bluebird.all([this.fileExists(path.join(gamePath, 'gog.ico')), fallback(gamePath)])
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

  private fileExists(filePath: string): Bluebird<boolean> {
    return Bluebird.resolve(fs.stat(filePath))
      .then(() => true)
      .catch(() => false);
  }

  private getGameEntries(): Bluebird<types.IGameStoreEntry[]> {
    if (process.platform === 'win32') {
      // Windows implementation using registry
      return this.getGameEntriesWindows();
    } else if (process.platform === 'darwin') {
      // macOS implementation
      return this.getGameEntriesMacOS();
    } else {
      return Bluebird.resolve([]);
    }
  }

  private getGameEntriesWindows(): Bluebird<types.IGameStoreEntry[]> {
    return (!!this.mClientPath)
      ? Bluebird.resolve(import('winapi-bindings')).then((winapi) => {
        return new Bluebird<types.IGameStoreEntry[]>((resolve, reject) => {
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
      }).catch(() => Bluebird.resolve([]))
      : Bluebird.resolve([]);
  }

  private getGameEntriesMacOS(): Bluebird<types.IGameStoreEntry[]> {
    // On macOS, we need to look for game info in the GOG Galaxy data directory
    const homeDir = process.env.HOME || '';
    const gogDataPath = path.join(homeDir, 'Library', 'Application Support', 'GOG.com', 'Galaxy');
    const gamesPath = path.join(gogDataPath, 'games');
    const gameEntries: types.IGameStoreEntry[] = [];

    return Bluebird.resolve(fs.stat(gogDataPath))
      .catch(() => undefined)
      .then(stat => {
        if (!stat) {
          return Bluebird.resolve<string[]>([]);
        }
        return Bluebird.resolve(fs.readdir(gamesPath)).catch(() => []);
      })
      .then((gameDirs: string[]) => {
        return Bluebird.map<string, void>(gameDirs, (gameId) => {
          const gameInfoPath = path.join(gamesPath, gameId, 'gameinfo');
          return Bluebird.resolve(fs.readFile(gameInfoPath, 'utf8'))
            .then((gameInfoData) => {
              try {
                const gameInfo = JSON.parse(gameInfoData);
                const appid = gameInfo.gameId || gameId;
                const name = gameInfo.name || gameInfo.title || `GOG Game ${appid}`;
                const gamePath = gameInfo.installDirectory;
                if (gamePath) {
                  return Bluebird.resolve(fs.stat(gamePath))
                    .then(() => {
                      gameEntries.push({ appid, name, gamePath, gameStoreId: STORE_ID });
                    })
                    .catch(() => {
                      log('debug', 'GOG game directory not found', { gamePath });
                    });
                }
              } catch (parseErr) {
                log('error', 'Failed to parse GOG game info', { gameId, error: parseErr.message });
              }
              return undefined;
            })
            .catch((err) => {
              log('debug', 'Failed to read GOG game info file', { gameId, error: err.message });
              return undefined;
            });
        }).then(() => gameEntries);
      })
      .catch((err) => {
        if (err) {
          log('error', 'Failed to get GOG games on macOS', { error: err.message });
        }
        return [];
      });
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