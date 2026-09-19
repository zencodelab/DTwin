'use client';

import { useMemo, useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { Html, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { SpatialTree } from '@dtwin/types';
import { STATUS } from '@/lib/colors';
import {
  SCENE_ROTATION, buildingBounds, extrudeZone, polygonCentroid,
} from '@/lib/geometry';

type Floor = SpatialTree['floors'][number];
type Zone = Floor['zones'][number];

export interface ZoneVisual {
  color: string;
  /** Formatted value for the on-canvas label — colour never stands alone. */
  label: string | null;
  alerting: boolean;
}

interface Props {
  tree: SpatialTree;
  visuals: Map<string, ZoneVisual>;
  focusedFloorId: string | null;
  selectedZoneId: string | null;
  onSelectZone: (zoneId: string | null) => void;
  onSelectFloor: (floorId: string | null) => void;
  showEquipment: boolean;
  isDark: boolean;
}

export function BuildingCanvas({
  tree, visuals, focusedFloorId, selectedZoneId,
  onSelectZone, onSelectFloor, showEquipment, isDark,
}: Props) {
  const bounds = useMemo(
    () => buildingBounds(tree.floors.map((f) => f.footprint)),
    [tree],
  );

  // The scene group is rotated so the local +Z-up CRS becomes three.js Y-up;
  // camera and target therefore live in the rotated frame: (x, z, −y).
  const target = useMemo<[number, number, number]>(
    () => [bounds.center.x, bounds.center.z, -bounds.center.y],
    [bounds],
  );
  const cameraPosition = useMemo<[number, number, number]>(
    () => [
      bounds.center.x + bounds.radius * 1.4,
      bounds.center.z + bounds.radius * 1.1,
      -bounds.center.y + bounds.radius * 1.4,
    ],
    [bounds],
  );

  return (
    <Canvas
      camera={{ position: cameraPosition, fov: 42, near: 0.1, far: bounds.radius * 40 }}
      dpr={[1, 2]}
      // Clicking past the building clears the selection, which is what every
      // user tries first to get out of a drill-down.
      onPointerMissed={() => {
        onSelectZone(null);
        onSelectFloor(null);
      }}
    >
      {/*
        The viewport is its own surface, not the page's.

        A diverging scale's midpoint is built to recede toward the surface it
        sits on — correct for a heatmap cell inside a bordered grid, fatal here,
        where the zone body IS the mark on an open canvas. Painted at the page
        colour, every zone near setpoint rendered at #f0efec against a #f9f9f7
        background and the building simply disappeared. A mid-tone backdrop
        gives the ramp's neutral end something to sit against in both
        directions, and keeps the validated ramp unchanged.
      */}
      <color attach="background" args={[isDark ? '#0d0d0d' : '#dedcd4']} />
      <hemisphereLight intensity={isDark ? 0.55 : 0.9} groundColor={isDark ? '#1a1a19' : '#e1e0d9'} />
      <directionalLight position={[60, 90, 40]} intensity={isDark ? 1.5 : 1.8} castShadow />
      <directionalLight position={[-40, 30, -50]} intensity={isDark ? 0.35 : 0.5} />

      <group rotation={SCENE_ROTATION}>
        {tree.floors.map((floor) => (
          <FloorGroup
            key={floor.id}
            floor={floor}
            visuals={visuals}
            dimmed={focusedFloorId !== null && focusedFloorId !== floor.id}
            focused={focusedFloorId === floor.id}
            selectedZoneId={selectedZoneId}
            onSelectZone={onSelectZone}
            onSelectFloor={onSelectFloor}
          />
        ))}

        {showEquipment &&
          tree.equipment
            .filter((e) => e.position !== null)
            .filter((e) => focusedFloorId === null || e.floorId === focusedFloorId)
            .map((e) => (
              <EquipmentMarker
                key={e.id}
                position={[e.position!.x, e.position!.y, e.position!.z]}
                status={e.status}
                tag={e.tag}
                showLabel={focusedFloorId !== null}
              />
            ))}

        <Grid bounds={bounds} isDark={isDark} />
      </group>

      <OrbitControls
        target={target}
        makeDefault
        maxPolarAngle={Math.PI / 2.05}
        minDistance={bounds.radius * 0.4}
        maxDistance={bounds.radius * 6}
      />
    </Canvas>
  );
}

function FloorGroup({
  floor, visuals, dimmed, focused, selectedZoneId, onSelectZone, onSelectFloor,
}: {
  floor: Floor;
  visuals: Map<string, ZoneVisual>;
  dimmed: boolean;
  focused: boolean;
  selectedZoneId: string | null;
  onSelectZone: (id: string | null) => void;
  onSelectFloor: (id: string | null) => void;
}) {
  const height = (floor.floorHeightM ?? 4) * 0.82; // leave a slab gap between floors

  return (
    <group>
      {floor.zones.map((zone) => (
        <ZoneMesh
          key={zone.id}
          zone={zone}
          height={height}
          visual={visuals.get(zone.id)}
          dimmed={dimmed}
          showLabel={focused}
          selected={selectedZoneId === zone.id}
          onSelect={() => {
            onSelectFloor(floor.id);
            onSelectZone(zone.id);
          }}
        />
      ))}
    </group>
  );
}

function ZoneMesh({
  zone, height, visual, dimmed, showLabel, selected, onSelect,
}: {
  zone: Zone;
  height: number;
  visual: ZoneVisual | undefined;
  dimmed: boolean;
  showLabel: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const mesh = useRef<THREE.Mesh>(null);

  const geometry = useMemo(
    () => (zone.boundary ? extrudeZone(zone.boundary, height) : null),
    [zone.boundary, height],
  );
  const centroid = useMemo(
    () => (zone.boundary ? polygonCentroid(zone.boundary) : null),
    [zone.boundary],
  );

  if (!geometry || !centroid) return null;

  const color = visual?.color ?? '#3a3a38';

  return (
    <group position={[0, 0, centroid.z]}>
      <mesh
        ref={mesh}
        geometry={geometry}
        castShadow
        receiveShadow
        onClick={(event) => {
          // Without this the click passes through to every zone behind it and
          // the last one wins — which is never the one under the cursor.
          event.stopPropagation();
          onSelect();
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          document.body.style.cursor = 'auto';
        }}
      >
        <meshStandardMaterial
          color={color}
          transparent
          opacity={dimmed ? 0.12 : 0.92}
          roughness={0.75}
          metalness={0.05}
          emissive={selected ? color : '#000000'}
          emissiveIntensity={selected ? 0.35 : 0}
        />
      </mesh>

      {/* A hairline edge so adjacent zones read as separate volumes rather than
          one continuous slab — the 3D equivalent of the 2px gap between fills. */}
      <lineSegments>
        <edgesGeometry args={[geometry]} />
        <lineBasicMaterial
          color={selected ? '#ffffff' : '#000000'}
          transparent
          opacity={dimmed ? 0.1 : selected ? 0.9 : 0.35}
        />
      </lineSegments>

      {showLabel && visual && (
        <Html
          position={[centroid.x, centroid.y, height + 0.4]}
          center
          distanceFactor={38}
          zIndexRange={[10, 0]}
          style={{ pointerEvents: 'none' }}
        >
          <div className="whitespace-nowrap rounded px-1.5 py-0.5 text-center text-[11px] leading-tight"
               style={{ background: 'rgba(13,13,13,0.78)', color: '#fff' }}>
            <div className="font-medium">{zone.name}</div>
            {visual.label && <div className="tnum opacity-90">{visual.label}</div>}
          </div>
        </Html>
      )}
    </group>
  );
}

function EquipmentMarker({
  position, status, tag, showLabel,
}: {
  position: [number, number, number];
  status: string;
  tag: string;
  showLabel: boolean;
}) {
  // Status is a reserved palette and always ships with a label, never colour
  // alone — a red dot on its own is not readable as "fault".
  const color =
    status === 'fault' ? STATUS.critical
    : status === 'maintenance' ? STATUS.warning
    : status === 'degraded' ? STATUS.serious
    : status === 'offline' ? '#898781'
    : STATUS.good;

  return (
    <group position={position}>
      <mesh>
        <sphereGeometry args={[0.55, 16, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.5} />
      </mesh>
      {showLabel && (
        <Html center distanceFactor={45} style={{ pointerEvents: 'none' }}>
          <div className="whitespace-nowrap rounded px-1 text-[10px]"
               style={{ background: 'rgba(13,13,13,0.8)', color: '#fff', transform: 'translateY(-14px)' }}>
            {tag}
          </div>
        </Html>
      )}
    </group>
  );
}

function Grid({ bounds, isDark }: {
  bounds: ReturnType<typeof buildingBounds>;
  isDark: boolean;
}) {
  const size = bounds.radius * 4;
  return (
    <mesh rotation={[0, 0, 0]} position={[bounds.center.x, bounds.center.y, -0.05]} receiveShadow>
      <planeGeometry args={[size, size]} />
      <meshStandardMaterial color={isDark ? '#141413' : '#c9c7bf'} roughness={1} />
    </mesh>
  );
}
