
const RETRY_INTERVAL = 120000;
const CLEANUP_INTERVAL = 3600000;
const CLEANUP_STALE_ENTRIES_THRESHOLD = 43200000;
          // 12hrs

let connections = {};
let cleanupTimerID = -1;
let notifyListenersChangedFlag = false;
let defaultPrefix = '/sse/';

let verbose = false;

function log(str) {
  if (verbose) {
    console.log('SSE: ' + str);
  }
}

///////////////////////////////////////////////////////////////////
//
// beg sse funcs (attached to res)
//
///////////////////////////////////////////////////////////////////
function sseHandler(req, res, next) {
  res.sseSetup = function(close) {
    let rspCode = close? 404 : 200;  // this isn't working on Chrome
    let contentType = close? 'text/plaintext' : 'text/event-stream';
    res.writeHead(rspCode, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    })
  }

  res.sseSend = function(retryInterval, data) {
    let msg = '';
//    if (retryInterval !== 0)   // chrome is ignoring this...
//      msg = "retry:" + retryInterval + "\n";

    msg += "data:" + JSON.stringify(data) + "\n\n";
    res.write(msg);
  }

  next();
}


//////////////////////////////////////////////////////////////////////
//
// end sse funcs
// beg async loop funcs
//
/////////////////////////////////////////////////////////////////////

function asyncNotifyListenersChanged() {
  return new Promise(function(acc, rej) {
    let sseRsps = Object.values(connections);
    if (sseRsps.length === 0)
      acc(true);

    else {
      let msg = "listeners-changed"; 
                  // work on a copy

      function notifyListenersChanged(ix) {
        while(true) {
          if (ix >= sseRsps.length) {
            acc(true);
            break;
          }

          if (sseRsps[ix]['registered-ts'] !== 0) {
            sseRsps[ix].notifyRes.sseSend(RETRY_INTERVAL, msg);
            break;
          }
          ++ix;
        }

        setImmediate(notifyListenersChanged.bind(null, ++ix));
      }

      notifyListenersChanged(0);
    }
  });
}

function asyncCleanupRegistered() {
  return new Promise(function(acc, rej) {
    log('in asyncCleanupRegistered');
    let idKeys = Object.keys(connections);
                    // pull a copy of the keys

    if (idKeys.length === 0) {
      log(' --> no connections (no keys)')
      acc(true); // nothing to do
    }
    else {
      function cleanupRegistered(ix) {
        if (ix >= idKeys.length)
          acc(true);

        else {
          let idKey, sseRsp, duration;

          while (true) {
                  // loop through the keys

            if (ix >= idKeys.length) {
              acc(true);
              break;
                    // done
            }

            idKey = idKeys[ix];
            if (!connections[idKey])
              continue;
                    // got deleted in between calls -
                    // go on to next without exiting

            sseRsp = connections[idKey];
            duration = Date.now() - sseRsp['registered-ts'];
            log(' --> duration for id: ' + idKey + ', registered-ts: ' +
                        sseRsp['registered-ts'] + ' = ' +
                        duration/1000);

            if (duration > CLEANUP_STALE_ENTRIES_THRESHOLD) {
              log(' --> removing: ' + idKey + ' from connections');
              delete connections[idKey];
                          // thpthpthp - gone.
              break;
            }
                    // else loop around for the next
            ++ix;
          }
          
          setImmediate(cleanupRegistered.bind(null, ++ix));
                    // trigger the next iteration
        }
      }

      cleanupRegistered(0);
                    // initial call
    }
  });
}

function startCleanupInterval() {
  function doCleanup() {
    cleanupTimerID = setTimeout(function() {
      clearTimeout(cleanupTimerID);
      cleanupTimerID = 0;
      asyncCleanupRegistered()
      .then(function(rsp){
        if (Object.keys(connections).length === 0)
          stopCleanupInterval();
        else {
          if (notifyListenersChangedFlag)
            setTimeout(asyncNotifyListenersChanged);
          if (cleanupTimerID === 0)
            setImmediate(doCleanup);
        }
      })
    }, CLEANUP_INTERVAL);
  }

  if (cleanupTimerID === -1)
    doCleanup();
}

function stopCleanupInterval() {
  if (cleanupTimerID > 0) {
    clearTimeout(cleanupTimerID);
    cleanupTimerID = -1;
  }
}
//////////////////////////////////////////////////////////////////
//
// end async loop funcs
// beg ServerEvent object
//
///////////////////////////////////////////////////////////////////

let ServerEventMgr = {
  createRouter(prefix) {
    let express = require('express');
    let serverEventRouter = express.Router();

    if (prefix === undefined) {
      prefix = defaultPrefix;
    }

    serverEventRouter.use(sseHandler);

    serverEventRouter.get(prefix + 'list-registrants', function(req, res) {
      res.send(ServerEventMgr.getListenersJSON());
    });
    
    serverEventRouter.get(prefix + 'clear-registrants', async function(req, res) {
      await ServerEventMgr.unregisterAllListeners();
      res.send("ok");
    });
    
    serverEventRouter.get(prefix + 'make-id/:name', function(req,rsp) {
      let id = ServerEventMgr.getUniqueID(req.params.name);
      rsp.send(id);
    });
    
    /**
     * register a listener
     */
    serverEventRouter.get(prefix + 'register-listener/:id', function(req, res) {
      let id = req.params.id;
      ServerEventMgr.registerListener(id, res);
              // res delegated to the ServerEventMgr -- 
              // don't respond here.
    });
    
    serverEventRouter.get(prefix + 'disconnect-registrant/:id', function(req,res){
      ServerEventMgr.unregisterListener(req.params.id);
      res.send('ok');
    });

    return serverEventRouter;
  },
  unregisterAllListeners() {
    stopCleanupInterval();
    connections = {};
  },
  setNotifyListenersChanged(flag) {
    notifyListenersChangedFlag = flag;
  },
  setVerbose(flag) {
    verbose = flag;
  },
  notifyListenersChanged() {
    asyncNotifyListenersChanged();
  },
  getUniqueID(name) {
    let id = '';
  
    log('server in make-id: ' + name);
    
    do {
      id = [name, Math.random().toString(36).substring(7)].join('_');
    } while (id in connections);

    return id;
  },
  registerListener(id, res) {
    resObj = id in connections? connections[id] : {},
    timeStamp = Date.now();

    log('in register-listener, id: ' + id);

    if (!(id in connections)) {
      startCleanupInterval();
      resObj['notifyRes'] = res;
      log(' --> server registered id: ' + id);
    } else {
      log(' --> is in connections');
    }

    res.sseSetup();
    res.sseSend(RETRY_INTERVAL, "registered^" + id);
    resObj['registered-ts'] = timeStamp;
    connections[id] = resObj;
  },
  isRegistered(id) {
    return(id in connections);
  },
  unregisterListener(id) {
    if (id in connections)
      delete connections[id];
    if (Object.keys(connections).length === 0)
      stopCleanupInterval();
  },
  getListenersJSON() {
    let idKeys = Object.keys(connections);
    let rspData = {}, tmpObj;
    
    for (let ix = 0; ix < idKeys.length; ++ix) {
      let idKey = idKeys[ix];

      if (connections[idKey] && connections[idKey]['registered-ts'] !== 0) {
        tmpObj = Object.assign({}, connections[idKey]);
        delete tmpObj.notifyRes;
        rspData[idKey] = tmpObj;
      }
    }

    return JSON.stringify(rspData);
  },
  notifyCompletions(id, taskid) {
    let name = id.split('_')[0];
    return new Promise(function(acc, rej) {
      let idKeys = Object.keys(connections);
                // get a current snapshot of the keys
  
      if (idKeys.length === 0)
        acc(true);
  
      else {
        function _notifyCompletions(ix) {
          if (ix >= idKeys.length)
            acc(true);
  
          else {
            let idKey = idKeys[ix];
            if ((idKey in connections) && idKey.startsWith(name)) {
              connections[idKey].notifyRes.sseSend(RETRY_INTERVAL, "completed^" +
                JSON.stringify({"timestamp": Date.now(), "id":idKey,
                                "taskid":taskid}));
                      // notify target listeners for specific event
            }
            
            setImmediate(_notifyCompletions.bind(null, ++ix));
          }
        }
        
        _notifyCompletions(0);
      }
    })
  }
};

module.exports = ServerEventMgr;