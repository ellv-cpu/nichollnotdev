const jobs = new Map();

function getUserJob(userId) {
  return jobs.get(Number(userId)) || null;
}

function setUserJob(userId, data) {
  jobs.set(Number(userId), { ...data, userId: Number(userId), updatedAt: Date.now() });
}

function removeUserJob(userId) {
  jobs.delete(Number(userId));
}

function isUserBuilding(userId) {
  return jobs.has(Number(userId));
}

function getActiveJobs() {
  return Array.from(jobs.values());
}

function getQueueStats() {
  const all = getActiveJobs();
  
  const waitingStatuses = ["waiting_zip", "waiting_url", "waiting_appname", "waiting_icon"];

  return {
    waiting: all.filter((j) => waitingStatuses.includes(j.status)).length,
    uploading: all.filter((j) => j.status === "uploading").length,
    building: all.filter((j) => j.status === "building").length,
    total: all.length,
  };
}

module.exports = {
  getUserJob,
  setUserJob,
  removeUserJob,
  isUserBuilding,
  getActiveJobs,
  getQueueStats,
};
