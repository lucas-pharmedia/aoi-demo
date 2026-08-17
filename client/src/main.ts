import Phaser from 'phaser';
import PhaserNavMeshPlugin from 'phaser-navmesh';
import { GameScene } from './scene.ts';

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: 1920,
  height: 1080,
  backgroundColor: '#000',
  scene: [GameScene],
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { x: 0, y: 0 },
      debug: false,
    },
  },
  pixelArt: true,
  roundPixels: true,
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  plugins: {
    scene: [
      {
        key: 'PhaserNavMeshPlugin',
        plugin: PhaserNavMeshPlugin,
        mapping: 'navMeshPlugin',
        start: true,
      },
    ],
  },
});