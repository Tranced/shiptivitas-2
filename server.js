import express from 'express';
import Database from 'better-sqlite3';

const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  return res.status(200).send({ 'message': 'SHIPTIVITY API. Read documentation to see API docs' });
});

// We are keeping one connection alive for the rest of the life application for simplicity
const db = new Database('./clients.db');

// Don't forget to close connection when server gets terminated
const closeDb = () => db.close();
process.on('SIGTERM', closeDb);
process.on('SIGINT', closeDb);

/**
 * Validate id input
 * @param {any} id
 */
const validateId = (id) => {
  if (Number.isNaN(id)) {
    return {
      valid: false,
      messageObj: {
        'message': 'Invalid id provided.',
        'long_message': 'Id can only be integer.',
      },
    };
  }
  const client = db.prepare('select * from clients where id = ? limit 1').get(id);
  if (!client) {
    return {
      valid: false,
      messageObj: {
        'message': 'Invalid id provided.',
        'long_message': 'Cannot find client with that id.',
      },
    };
  }
  return {
    valid: true,
  };
}

/**
 * Validate priority input
 * @param {any} priority
 */
const validatePriority = (priority) => {
  if (Number.isNaN(priority)) {
    return {
      valid: false,
      messageObj: {
        'message': 'Invalid priority provided.',
        'long_message': 'Priority can only be positive integer.',
      },
    };
  }
  return {
    valid: true,
  }
}

/**
 * Get all of the clients. Optional filter 'status'
 * GET /api/v1/clients?status={status} - list all clients, optional parameter status: 'backlog' | 'in-progress' | 'complete'
 */
app.get('/api/v1/clients', (req, res) => {
  const status = req.query.status;
  if (status) {
    // status can only be either 'backlog' | 'in-progress' | 'complete'
    if (status !== 'backlog' && status !== 'in-progress' && status !== 'complete') {
      return res.status(400).send({
        'message': 'Invalid status provided.',
        'long_message': 'Status can only be one of the following: [backlog | in-progress | complete].',
      });
    }
    const clients = db.prepare('select * from clients where status = ?').all(status);
    return res.status(200).send(clients);
  }
  const statement = db.prepare('select * from clients');
  const clients = statement.all();
  return res.status(200).send(clients);
});

/**
 * Get a client based on the id provided.
 * GET /api/v1/clients/{client_id} - get client by id
 */
app.get('/api/v1/clients/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { valid, messageObj } = validateId(id);
  if (!valid) {
    res.status(400).send(messageObj);
  }
  return res.status(200).send(db.prepare('select * from clients where id = ?').get(id));
});

/**
 * Update client information based on the parameters provided.
 * When status is provided, the client status will be changed
 * When priority is provided, the client priority will be changed with the rest of the clients accordingly
 * Note that priority = 1 means it has the highest priority (should be on top of the swimlane).
 * No client on the same status should not have the same priority.
 * This API should return list of clients on success
 *
 * PUT /api/v1/clients/{client_id} - change the status of a client
 *    Data:
 *      status (optional): 'backlog' | 'in-progress' | 'complete',
 *      priority (optional): integer,
 *
 */
const validateStatus = (status) => {
  if (status !== "backlog" && status !== "in-progress" && status !== "complete") {
    return {
      valid: false,
      messageObj: {
        'message': 'Invalid status provided.',
        'long_message': 'Status can only be backlog, in-progress, or complete',
      },
    };
  }
  return {
    valid: true,
  }
}

app.put('/api/v1/clients/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { valid, messageObj } = validateId(id);
  if (!valid) {
    res.status(400).send(messageObj);
  }

  let { status, priority } = req.body;
  let clients = db.prepare('select * from clients').all();
  let client = clients.find(client => client.id === id);
  /* ---------- Update code below ----------*/
  if (status === undefined && priority === undefined) {
    //short circuit if both things are undefined
    return res.status(200).send(clients);
  }

  if (status !== undefined) {
    const { valid, messageObj } = validateStatus(status);
    if (!valid) {
      return res.status(400).send(messageObj);
    }
  }
  if (priority !== undefined) {
    const { valid, messageObj } = validatePriority(priority);
    if (!valid) {
      return res.status(400).send(messageObj);
    }
  }
  if (client.status === status && client.priority === priority || status === undefined && client.priority === priority || client.status === status && priority === undefined) {
    //short circuit if put parameters are same as existing client
    return res.status(200).send(clients);
  }
  let laneLength = clients.filter(client => client.status === status).length


  const update = db.prepare('update clients set status=?, priority=? where id=?')
  //Assuming status is different
  if (status) {
    update.run(status, laneLength, id);
    const prevLane = db.prepare('update clients set priority=priority-1 where priority > ? and status = ?')
    prevLane.run(client.priority, client.status);
    client.priority = laneLength;
  }
  laneLength = clients.filter(client => client.status === status).length;
  //if status is different, row is appended to the end of new status
  //if it's not, we're working in the same swimlane
  if (priority) {
    const shiftLane = db.prepare('update clients set priority=priority-1 where priority > ? and status = ?');
    const makeSpace = db.prepare('update clients set priority=priority+1 where priority >= ? and status = ?');
    // const unMakeSpace = db.prepare('update clients set priority=priority-1 where priority >= ? and status = ?');


    //assigning lowest priority in same lane
    if (priority >= laneLength && client.status === status) {

      //append to end
      update.run(status, laneLength, id);
      //shift back 
      shiftLane.run(client.priority, client.status);

      //if priority gets lowered
    } else if (priority > client.priority && priority < laneLength) {

      makeSpace.run(priority, client.status)
      //insert
      update.run(status, priority, id);
      shiftLane.run(client.priority - 1, status);
      //priority get increased
    } else if (priority < client.priority) {

      update.run(status, 0, id);
      //shift all rows above to priority-1
      if (client.priority < laneLength - 1) {
        shiftLane.run(client.priority, status);
      }

      //make empty space at priority
      makeSpace.run(priority, status);

      //insert into empty space
      update.run(status, priority, id);
    }

  }

  clients = db.prepare('select * from clients').all();

  return res.status(200).send(clients);
});

app.listen(3001);
console.log('app running on port ', 3001);
