import { GoGLauncher } from '../src/index';
import * as path from 'path';
import * as fs from 'fs-extra';
import { types } from 'vortex-api';

// Mock the vortex-api
jest.mock('vortex-api', () => ({
  log: jest.fn(),
  types: {
    IGameStore: jest.fn(),
    IGameStoreEntry: jest.fn(),
    GameEntryNotFound: jest.fn()
  }
}));

// Mock fs-extra
jest.mock('fs-extra', () => ({
  stat: jest.fn(),
  readdir: jest.fn(),
  readFile: jest.fn()
}));

describe('GoGLauncher', () => {
  let gogLauncher: GoGLauncher;
  
  beforeEach(() => {
    // Mock process.platform to test macOS functionality
    Object.defineProperty(process, 'platform', {
      value: 'darwin'
    });
    
    // Reset mocks
    (fs.stat as jest.Mock).mockReset();
    (fs.readdir as jest.Mock).mockReset();
    (fs.readFile as jest.Mock).mockReset();
    
    gogLauncher = new GoGLauncher();
  });
  
  describe('findMacOSGOGPath', () => {
    it('should find GOG Galaxy in standard Applications directory', async () => {
      (fs.stat as jest.Mock).mockImplementation((filePath) => {
        if (filePath === '/Applications/GOG Galaxy.app') {
          return Promise.resolve({ isDirectory: () => true });
        }
        return Promise.reject(new Error('File not found'));
      });
      
      const result = await (gogLauncher as any).findMacOSGOGPath();
      expect(result).toBe('/Applications/GOG Galaxy.app');
    });
    
    it('should find GOG Galaxy in user Applications directory', async () => {
      (fs.stat as jest.Mock).mockImplementation((filePath) => {
        if (filePath === path.join(process.env.HOME || '', 'Applications', 'GOG Galaxy.app')) {
          return Promise.resolve({ isDirectory: () => true });
        }
        return Promise.reject(new Error('File not found'));
      });
      
      const result = await (gogLauncher as any).findMacOSGOGPath();
      expect(result).toBe(path.join(process.env.HOME || '', 'Applications', 'GOG Galaxy.app'));
    });
    
    it('should reject if GOG Galaxy is not found', async () => {
      (fs.stat as jest.Mock).mockRejectedValue(new Error('File not found'));
      
      await expect((gogLauncher as any).findMacOSGOGPath()).rejects.toThrow('GOG Galaxy not found on macOS');
    });
  });
  
  describe('getGameEntriesMacOS', () => {
    it('should return empty array if GOG data directory does not exist', async () => {
      (fs.stat as jest.Mock).mockRejectedValue(new Error('File not found'));
      
      const result = await (gogLauncher as any).getGameEntriesMacOS();
      expect(result).toEqual([]);
    });
    
    it('should return game entries when games are found', async () => {
      // Mock the data directory exists
      (fs.stat as jest.Mock).mockImplementation((filePath) => {
        if (filePath.includes('Library/Application Support/GOG.com/Galaxy')) {
          return Promise.resolve({ isDirectory: () => true });
        }
        return Promise.reject(new Error('File not found'));
      });
      
      // Mock readdir to return game directories
      (fs.readdir as jest.Mock).mockResolvedValue(['12345', '67890']);
      
      // Mock readFile to return game info
      (fs.readFile as jest.Mock).mockImplementation((filePath) => {
        if (filePath.includes('12345/gameinfo')) {
          return Promise.resolve(JSON.stringify({
            gameId: '12345',
            name: 'Test Game 1',
            installDirectory: '/Games/Test Game 1'
          }));
        } else if (filePath.includes('67890/gameinfo')) {
          return Promise.resolve(JSON.stringify({
            gameId: '67890',
            name: 'Test Game 2',
            installDirectory: '/Games/Test Game 2'
          }));
        }
        return Promise.reject(new Error('File not found'));
      });
      
      // Mock stat to verify game paths exist
      (fs.stat as jest.Mock).mockImplementation((filePath) => {
        if (filePath === '/Games/Test Game 1' || filePath === '/Games/Test Game 2') {
          return Promise.resolve({ isDirectory: () => true });
        } else if (filePath.includes('Library/Application Support/GOG.com/Galaxy')) {
          return Promise.resolve({ isDirectory: () => true });
        }
        return Promise.reject(new Error('File not found'));
      });
      
      const result = await (gogLauncher as any).getGameEntriesMacOS();
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        appid: '12345',
        name: 'Test Game 1',
        gamePath: '/Games/Test Game 1',
        gameStoreId: 'gog'
      });
      expect(result[1]).toEqual({
        appid: '67890',
        name: 'Test Game 2',
        gamePath: '/Games/Test Game 2',
        gameStoreId: 'gog'
      });
    });
  });
});