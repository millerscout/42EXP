import {db} from '../config.js';

export const vote = function(data){
  const xp_value = data.voter_level * 5;
  return db.tx((t) => {
    return t.none('INSERT INTO votes (voter,votee,skill) values ($1,$2,$3)',[
        data.voter,data.votee,data.account_skill_id
      ])
      .then(function(){
        return t.one('UPDATE account SET xp = xp + $1 where username=$2 returning xp,level',[xp_value,data.votee])
      }).then(function(stats){
        return {vote:'success',stats:stats,skillName:data.skill,xp_value}
      })
  })
  .then(function(status){
    return status
  })
  .catch(function(err){
    throw 'Cannot commend already commended user'
  })
}
