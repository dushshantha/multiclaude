/**
 * dag-graph.js — Standalone SVG task-dependency graph renderer.
 *
 * Usage:
 *   renderDag(container, tasks, edges [, options])
 *
 *   container  HTMLElement to render into
 *   tasks      Array of { id, title, status }
 *   edges      Array of { from_task, to_task }  (from = dependency, to = dependent)
 *   options    Optional layout overrides (nodeWidth, nodeHeight, hGap, vGap, margin)
 *
 * Exposes window.renderDag when loaded via <script src>.
 */
(function (global) {
  'use strict';

  var _dagCounter = 0;

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var STATUS_COLORS = {
    pending:     { fill: '#2a2a4e', stroke: '#555',    text: '#888' },
    in_progress: { fill: '#1e1e5e', stroke: '#7c83fd', text: '#7c83fd' },
    done:        { fill: '#14532d', stroke: '#4ade80', text: '#4ade80' },
    failed:      { fill: '#450a0a', stroke: '#f87171', text: '#f87171' },
    cancelled:   { fill: '#1c1c1c', stroke: '#444',    text: '#555' },
  };

  /**
   * Render a task-dependency DAG as SVG.
   *
   * Arrows run left-to-right from dependency to dependent.
   * Hover or click a node to highlight its connected edges and neighbours;
   * click again (or click the SVG background) to clear the selection.
   */
  function renderDag(container, tasks, edges, options) {
    if (!container || !tasks || tasks.length === 0) {
      if (container) container.style.display = 'none';
      return;
    }
    container.style.display = 'block';

    var opts = options || {};
    var NW = opts.nodeWidth  !== undefined ? opts.nodeWidth  : 180;
    var NH = opts.nodeHeight !== undefined ? opts.nodeHeight : 50;
    var HG = opts.hGap      !== undefined ? opts.hGap      : 80;
    var VG = opts.vGap      !== undefined ? opts.vGap      : 14;
    var M  = opts.margin    !== undefined ? opts.margin    : 24;

    // Unique prefix so multiple graphs on one page don't share marker IDs
    var uid = 'dag' + (++_dagCounter);

    // Index tasks
    var taskById = {};
    tasks.forEach(function (t) { taskById[t.id] = t; });

    // Build incoming-deps map: taskId -> [from_task_ids that must finish first]
    var inDeps = {};
    tasks.forEach(function (t) { inDeps[t.id] = []; });
    var validEdges = (edges || []).filter(function (e) {
      return taskById[e.from_task] && taskById[e.to_task];
    });
    validEdges.forEach(function (e) {
      if (inDeps[e.to_task] !== undefined) {
        inDeps[e.to_task].push(e.from_task);
      }
    });

    // Topological levels (cycle guard: if a cycle is detected, treat level as 0)
    var levels = {};
    var visiting = {};
    function computeLevel(id) {
      if (levels[id] !== undefined) return levels[id];
      if (visiting[id]) { levels[id] = 0; return 0; }
      visiting[id] = true;
      var deps = inDeps[id] || [];
      if (deps.length === 0) {
        levels[id] = 0;
      } else {
        var max = 0;
        for (var i = 0; i < deps.length; i++) {
          var l = computeLevel(deps[i]);
          if (l + 1 > max) max = l + 1;
        }
        levels[id] = max;
      }
      visiting[id] = false;
      return levels[id];
    }
    tasks.forEach(function (t) { computeLevel(t.id); });

    // Group into waves (columns) by level
    var maxLevel = 0;
    tasks.forEach(function (t) { if (levels[t.id] > maxLevel) maxLevel = levels[t.id]; });
    var waves = [];
    for (var w = 0; w <= maxLevel; w++) waves.push([]);
    tasks.forEach(function (t) { waves[levels[t.id]].push(t); });

    // SVG canvas size
    var svgW = M * 2 + waves.length * NW + (waves.length - 1) * HG;
    var maxWaveH = 0;
    waves.forEach(function (wave) {
      var h = wave.length * NH + Math.max(0, wave.length - 1) * VG;
      if (h > maxWaveH) maxWaveH = h;
    });
    var svgH = M * 2 + maxWaveH;

    // Node centre positions
    var pos = {};
    waves.forEach(function (wave, wi) {
      var waveH = wave.length * NH + Math.max(0, wave.length - 1) * VG;
      var startY = M + (maxWaveH - waveH) / 2;
      wave.forEach(function (t, ti) {
        var x = M + wi * (NW + HG);
        var y = startY + ti * (NH + VG);
        pos[t.id] = { x: x, y: y, cx: x + NW / 2, cy: y + NH / 2 };
      });
    });

    // Build SVG markup
    var parts = [];
    parts.push(
      '<svg xmlns="http://www.w3.org/2000/svg"' +
      ' width="' + svgW + '" height="' + svgH + '"' +
      ' style="display:block;cursor:default" data-dag-root="1">'
    );

    // Arrow markers: normal, dimmed, highlighted
    parts.push('<defs>');
    // Normal arrow — visible indigo tip
    parts.push(
      '<marker id="' + uid + '-arr"' +
      ' markerWidth="10" markerHeight="7" refX="10" refY="3.5"' +
      ' orient="auto" markerUnits="userSpaceOnUse">' +
      '<polygon points="0 0, 10 3.5, 0 7" fill="#7c83fd"/>' +
      '</marker>'
    );
    // Dimmed arrow — almost invisible
    parts.push(
      '<marker id="' + uid + '-arr-dim"' +
      ' markerWidth="10" markerHeight="7" refX="10" refY="3.5"' +
      ' orient="auto" markerUnits="userSpaceOnUse">' +
      '<polygon points="0 0, 10 3.5, 0 7" fill="#333"/>' +
      '</marker>'
    );
    // Highlighted arrow — bright white, slightly larger
    parts.push(
      '<marker id="' + uid + '-arr-hi"' +
      ' markerWidth="12" markerHeight="8" refX="12" refY="4"' +
      ' orient="auto" markerUnits="userSpaceOnUse">' +
      '<polygon points="0 0, 12 4, 0 8" fill="#fff"/>' +
      '</marker>'
    );
    parts.push('</defs>');

    // Edges drawn first so they appear behind nodes.
    // Direction: from_task (dependency) → to_task (dependent), left-to-right.
    validEdges.forEach(function (e) {
      var s = pos[e.from_task], d = pos[e.to_task];
      if (!s || !d) return;
      // Exit from right-centre of source, enter left-centre of destination
      var x1 = s.x + NW;
      var y1 = s.cy;
      var x2 = d.x;
      var y2 = d.cy;
      var midX = (x1 + x2) / 2;
      parts.push(
        '<path class="dag-edge"' +
        ' data-from="' + escapeHtml(e.from_task) + '"' +
        ' data-to="' + escapeHtml(e.to_task) + '"' +
        ' d="M' + x1 + ',' + y1 +
        ' C' + midX + ',' + y1 + ' ' + midX + ',' + y2 + ' ' + x2 + ',' + y2 + '"' +
        ' fill="none"' +
        ' stroke="#7c83fd" stroke-width="1.5" stroke-opacity="0.55"' +
        ' marker-end="url(#' + uid + '-arr)"/>'
      );
    });

    // Nodes
    tasks.forEach(function (t) {
      var p = pos[t.id];
      if (!p) return;
      var c = STATUS_COLORS[t.status] || STATUS_COLORS.pending;
      var raw = t.title || t.id;
      // Truncate long titles with ellipsis
      var label = raw.length > 22 ? raw.slice(0, 21) + '…' : raw;
      var statusText = (t.status || 'pending').replace(/_/g, ' ');

      parts.push(
        '<g class="dag-node" data-task-id="' + escapeHtml(t.id) + '" style="cursor:pointer">'
      );
      // Native SVG tooltip (browser shows on hover after a short delay)
      parts.push(
        '<title>' + escapeHtml(raw) + ' — ' + escapeHtml(statusText) + '</title>'
      );
      parts.push(
        '<rect x="' + p.x + '" y="' + p.y + '"' +
        ' width="' + NW + '" height="' + NH + '" rx="5"' +
        ' fill="' + c.fill + '" stroke="' + c.stroke + '" stroke-width="1.5"/>'
      );
      parts.push(
        '<text x="' + p.cx + '" y="' + (p.cy - 6) + '"' +
        ' text-anchor="middle"' +
        ' fill="' + c.text + '"' +
        ' font-family="\'Courier New\',monospace" font-size="11">' +
        escapeHtml(label) + '</text>'
      );
      parts.push(
        '<text x="' + p.cx + '" y="' + (p.cy + 11) + '"' +
        ' text-anchor="middle"' +
        ' fill="' + c.text + '"' +
        ' font-family="\'Courier New\',monospace" font-size="10" opacity="0.7">' +
        escapeHtml(statusText) + '</text>'
      );
      parts.push('</g>');
    });

    parts.push('</svg>');
    container.innerHTML = parts.join('');

    // ---- Interactivity ----
    var svgEl   = container.querySelector('[data-dag-root]');
    var nodeEls = container.querySelectorAll('.dag-node');
    var edgeEls = container.querySelectorAll('.dag-edge');
    var activeNodeId = null;

    // Pre-compute adjacency sets for O(1) neighbour lookup
    var neighbors = {};   // taskId -> Set of adjacent task ids
    var connEdges  = {};  // taskId -> Set of connected edge elements
    tasks.forEach(function (t) {
      neighbors[t.id] = {};   // plain object used as Set
      connEdges[t.id]  = [];
    });
    edgeEls.forEach(function (el) {
      var from = el.getAttribute('data-from');
      var to   = el.getAttribute('data-to');
      if (neighbors[from]) { neighbors[from][to] = true; connEdges[from].push(el); }
      if (neighbors[to])   { neighbors[to][from] = true; connEdges[to].push(el); }
    });

    function applyHighlight(tid) {
      var nbrs = neighbors[tid] || {};
      var myEdges = connEdges[tid] || [];

      nodeEls.forEach(function (el) {
        var etid = el.getAttribute('data-task-id');
        el.style.opacity = (etid === tid || nbrs[etid]) ? '1' : '0.15';
      });

      edgeEls.forEach(function (el) {
        var isConn = false;
        for (var i = 0; i < myEdges.length; i++) {
          if (myEdges[i] === el) { isConn = true; break; }
        }
        if (isConn) {
          el.style.strokeOpacity = '1';
          el.style.stroke = '#fff';
          el.setAttribute('marker-end', 'url(#' + uid + '-arr-hi)');
        } else {
          el.style.strokeOpacity = '0.08';
          el.style.stroke = '#444';
          el.setAttribute('marker-end', 'url(#' + uid + '-arr-dim)');
        }
      });
    }

    function clearHighlight() {
      nodeEls.forEach(function (el) { el.style.opacity = '1'; });
      edgeEls.forEach(function (el) {
        el.style.strokeOpacity = '0.55';
        el.style.stroke = '#7c83fd';
        el.setAttribute('marker-end', 'url(#' + uid + '-arr)');
      });
    }

    nodeEls.forEach(function (el) {
      var tid = el.getAttribute('data-task-id');

      el.addEventListener('mouseenter', function () {
        if (!activeNodeId) applyHighlight(tid);
      });

      el.addEventListener('mouseleave', function () {
        if (!activeNodeId) clearHighlight();
      });

      el.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (activeNodeId === tid) {
          activeNodeId = null;
          clearHighlight();
        } else {
          activeNodeId = tid;
          applyHighlight(tid);
        }
      });
    });

    // Click SVG background to deselect
    if (svgEl) {
      svgEl.addEventListener('click', function () {
        if (activeNodeId) {
          activeNodeId = null;
          clearHighlight();
        }
      });
    }
  }

  global.renderDag = renderDag;

})(typeof window !== 'undefined' ? window : this);
