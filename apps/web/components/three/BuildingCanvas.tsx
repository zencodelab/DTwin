'use client';

import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
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
  /**
   * Why the zone is grey, or what its colour rests on — "no reading · 4 min",
   * "reading flagged", "2 of 3 points". A grey zone with no words reads as "no
   * sensor here", which is a different fact from "the sensor here went quiet".
   */
  note: string | null;
  alerting: boolean;
}

function sameVisual(a: ZoneVisual | undefined, b: ZoneVisual | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.color === b.color && a.label === b.label
    && a.note === b.note && a.alerting === b.alerting;
}

interface Props {
  tree: SpatialTree;
  visuals: Map<string, ZoneVisual>;
  focusedFloorId: string | null;
  selectedZoneId: string | null;
  /** Zones a pending copilot plan would change. Drawn with an amber glow. */
  highlightedZoneIds: ReadonlySet<string>;
  onSelectZone: (zoneId: string | null) => void;
  onSelectFloor: (floorId: string | null) => void;
  showEquipment: boolean;
  isDark: boolean;
}

export function BuildingCanvas({
  tree, visuals, focusedFloorId, selectedZoneId, highlightedZoneIds,
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
            highlightedZoneIds={highlightedZoneIds}
            onSelectZone={onSelectZone}
            onSelectFloor={onSelectFloor}
          />
        ))}

        {showEquipment && (
          <EquipmentMarkers
            equipment={tree.equipment}
            focusedFloorId={focusedFloorId}
          />
        )}

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
  floor, visuals, dimmed, focused, selectedZoneId, highlightedZoneIds, onSelectZone, onSelectFloor,
}: {
  floor: Floor;
  visuals: Map<string, ZoneVisual>;
  dimmed: boolean;
  focused: boolean;
  selectedZoneId: string | null;
  highlightedZoneIds: ReadonlySet<string>;
  onSelectZone: (id: string | null) => void;
  onSelectFloor: (id: string | null) => void;
}) {
  const height = (floor.floorHeightM ?? 4) * 0.82; // leave a slab gap between floors

  // One callback for every zone on this floor, stable across renders. An
  // inline closure per zone would be a new prop each time and would defeat
  // ZoneMesh's memo entirely.
  const select = useCallback((floorId: string, zoneId: string) => {
    onSelectFloor(floorId);
    onSelectZone(zoneId);
  }, [onSelectFloor, onSelectZone]);

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
          highlighted={highlightedZoneIds.has(zone.id)}
          onSelect={select}
        />
      ))}
    </group>
  );
}

/**
 * How many meshes currently think the pointer is over them.
 *
 * `onPointerOut` on one mesh can fire after `onPointerOver` on the next when
 * the pointer crosses a shared edge, and the naive version — set `pointer` on
 * over, `auto` on out — then leaves the cursor as an arrow while it is still
 * over a zone, or as a pointer after it has left the building entirely. A
 * count is the only thing that survives the ordering.
 */
let hoverCount = 0;

function setHovered(hovered: boolean): void {
  hoverCount = Math.max(0, hoverCount + (hovered ? 1 : -1));
  document.body.style.cursor = hoverCount > 0 ? 'pointer' : 'auto';
}

const ZoneMesh = memo(function ZoneMesh({
  zone, height, visual, dimmed, showLabel, selected, highlighted, onSelect,
}: {
  zone: Zone;
  height: number;
  visual: ZoneVisual | undefined;
  dimmed: boolean;
  showLabel: boolean;
  selected: boolean;
  /** Part of a plan awaiting approval: the zone the operator is deciding about. */
  highlighted: boolean;
  /**
   * Takes the zone id rather than closing over it, so the parent can pass one
   * callback for every zone. An inline `() => onSelect(zone.id)` in the parent
   * is a new function on each render, which defeats the memo above — the
   * component would re-render all 24 zones on every telemetry frame regardless
   * of whether any of their values changed.
   */
  onSelect: (floorId: string, zoneId: string) => void;
}) {
  const mesh = useRef<THREE.Mesh>(null);

  const geometry = useMemo(
    () => (zone.boundary ? extrudeZone(zone.boundary, height) : null),
    [zone.boundary, height],
  );

  // Extruded geometry is allocated on the GPU and is not garbage-collected
  // with the React element. Without this, changing floor height or navigating
  // away leaks a buffer per zone.
  useEffect(() => () => geometry?.dispose(), [geometry]);
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
          onSelect(zone.floorId, zone.id);
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          setHovered(true);
        }}
        onPointerOut={() => setHovered(false)}
      >
        <meshStandardMaterial
          color={color}
          transparent
          opacity={dimmed ? 0.12 : 0.92}
          roughness={0.75}
          metalness={0.05}
          emissive={highlighted ? STATUS.warning : selected ? color : '#000000'}
          emissiveIntensity={highlighted ? 0.55 : selected ? 0.35 : 0}
        />
      </mesh>

      {/* A hairline edge so adjacent zones read as separate volumes rather than
          one continuous slab — the 3D equivalent of the 2px gap between fills. */}
      <lineSegments>
        <edgesGeometry args={[geometry]} />
        <lineBasicMaterial
          color={highlighted ? STATUS.warning : selected ? '#ffffff' : '#000000'}
          transparent
          opacity={dimmed ? 0.1 : highlighted || selected ? 0.9 : 0.35}
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
            {visual.note && (
              <div className="tnum text-[10px]" style={{ color: STATUS.warning }}>{visual.note}</div>
            )}
          </div>
        </Html>
      )}
    </group>
  );
}, (prev, next) =>
  // The default comparison is by reference, and `visual` is a fresh object for
  // every zone each time the dashboard recomputes — which is every telemetry
  // frame. So the memo added with the stable `onSelect` never once held: the
  // callback was fixed and this prop was not. Compare what the visual SAYS.
  prev.zone === next.zone
  && prev.height === next.height
  && prev.dimmed === next.dimmed
  && prev.showLabel === next.showLabel
  && prev.selected === next.selected
  && prev.highlighted === next.highlighted
  && prev.onSelect === next.onSelect
  && sameVisual(prev.visual, next.visual));

/**
 * Status is a reserved palette and always ships with a label, never colour
 * alone — a red dot on its own is not readable as "fault".
 */
function statusColor(status: string): string {
  return status === 'fault' ? STATUS.critical
    : status === 'maintenance' ? STATUS.warning
    : status === 'degraded' ? STATUS.serious
    : status === 'offline' ? '#898781'
    : STATUS.good;
}

const MARKER_DUMMY = new THREE.Object3D();
const MARKER_COLOR = new THREE.Color();

/**
 * Every equipment marker in one draw call.
 *
 * These were forty separate meshes, each with its own sphere geometry and its
 * own material — forty draw calls and forty materials for forty identical
 * spheres that differ only in position and colour. An InstancedMesh uploads
 * the geometry once and the per-instance transform and colour as buffers, so
 * the cost stops scaling with the asset count. It matters at 40 and it decides
 * whether this works at 400.
 *
 * The labels stay as separate DOM overlays: they are only rendered when a
 * floor is focused, which is at most ten of them, and text cannot be
 * instanced anyway.
 */
function EquipmentMarkers({
  equipment, focusedFloorId,
}: {
  equipment: SpatialTree['equipment'];
  focusedFloorId: string | null;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);

  const visible = useMemo(
    () => equipment.filter(
      (e) => e.position !== null
        && (focusedFloorId === null || e.floorId === focusedFloorId),
    ),
    [equipment, focusedFloorId],
  );

  // Positions and colours are written into the instance buffers rather than
  // into React elements, so a status change costs a buffer update instead of
  // forty reconciliations.
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;

    visible.forEach((e, i) => {
      MARKER_DUMMY.position.set(e.position!.x, e.position!.y, e.position!.z);
      MARKER_DUMMY.updateMatrix();
      mesh.setMatrixAt(i, MARKER_DUMMY.matrix);
      mesh.setColorAt(i, MARKER_COLOR.set(statusColor(e.status)));
    });
    mesh.count = visible.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [visible]);

  if (visible.length === 0) return null;

  return (
    <>
      {/* `key` on the length: an InstancedMesh cannot grow past the count it
          was allocated with, so a floor with more equipment than the last one
          needs a new buffer rather than a resized one. */}
      <instancedMesh
        key={visible.length}
        ref={ref}
        args={[undefined, undefined, visible.length]}
      >
        <sphereGeometry args={[0.55, 16, 16]} />
        {/*
          Unlit, and that is a correction rather than a compromise. These were
          lit spheres with an emissive tint, so a marker on the shaded side of
          the building rendered darker than the same status on the lit side —
          a status indicator whose colour depends on where it happens to sit is
          not a status indicator. `toneMapped={false}` keeps the palette's
          exact value rather than the renderer's interpretation of it.

          It is also what makes per-instance colour work: `setColorAt` writes
          the base colour, and a standard material's `emissive` is a uniform
          shared by every instance, so the glow could not have varied anyway.
        */}
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>

      {focusedFloorId !== null && visible.map((e) => (
        <Html
          key={e.id}
          center
          distanceFactor={45}
          position={[e.position!.x, e.position!.y, e.position!.z]}
          style={{ pointerEvents: 'none' }}
        >
          <div className="whitespace-nowrap rounded px-1 text-[10px]"
               style={{ background: 'rgba(13,13,13,0.8)', color: '#fff', transform: 'translateY(-14px)' }}>
            {e.tag}
          </div>
        </Html>
      ))}
    </>
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
