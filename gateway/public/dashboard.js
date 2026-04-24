let isFetching = false;

async function updateDashboard() {
  if (isFetching) return;
  isFetching = true;

  try {
    const res = await fetch('/cluster-status');
    const results = await res.json();

    const activeNodes = results.filter(r => r !== null).length;
    const hasQuorum = activeNodes >= 2;

    results.forEach((data, i) => {
      const el = document.getElementById(`r${i + 1}`);

      if (!data) {
        el.className = "card down";
        el.innerHTML = `
          <h2><i class="fa-solid fa-skull-crossbones"></i> Replica ${i + 1}</h2>
          <p><b>State:</b> <span class="badge badge-down">OFFLINE</span></p>
          <p><b>Term:</b> <span>---</span></p>
          <p><b>Logs:</b> <span>---</span></p>
        `;
        return;
      }

      el.className = "card " + (data.state === "LEADER" ? "leader" : "follower");
      
      // Choose the right FontAwesome icon based on state
      const icon = data.state === "LEADER" 
        ? '<i class="fa-solid fa-crown" style="color: #10b981;"></i>' 
        : '<i class="fa-solid fa-gear" style="color: #3b82f6;"></i>';

      el.innerHTML = `
        <h2>${icon} Replica ${data.replicaId}</h2>
        <p><b>State:</b> <span class="badge badge-${data.state.toLowerCase()}">${data.state}</span></p>
        <p><b>Term:</b> <span>${data.currentTerm}</span></p>
        <p><b>Logs:</b> <span>${data.totalLogs}</span></p>
      `;
    });

    let leader = null;
    if (hasQuorum) { leader = results.find(r => r && r.state === "LEADER"); }

    const summaryEl = document.getElementById("summary");
    if (!hasQuorum) {
      summaryEl.innerHTML = `<span style="color: #ef4444;"><i class="fa-solid fa-triangle-exclamation"></i> Cluster Unstable (No Quorum)</span>`;
    } else if (!leader) {
      summaryEl.innerHTML = `<span style="color: #f59e0b;"><i class="fa-solid fa-bolt"></i> Electing Leader...</span>`;
    } else {
      summaryEl.innerHTML = `<span style="color: #10b981;"><i class="fa-solid fa-circle-check"></i> Healthy | Leader: Replica ${leader.replicaId} (Term ${leader.currentTerm})</span>`;
    }

  } catch (err) {
    console.error("Dashboard error:", err);
  }

  isFetching = false;
}

setInterval(updateDashboard, 1500);
updateDashboard();