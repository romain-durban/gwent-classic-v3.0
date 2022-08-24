"use strict"

class Controller {}

var nilfgaard_wins_draws = false;

// Makes decisions for the AI opponent player
class ControllerAI {
	constructor(player) {
		this.player = player;
	}

	// Collects data and weighs options before taking a weighted random action
	async startTurn(player) {
		if (player.opponent().passed && (player.winning || player.deck.faction === "nilfgaard" && player.total === player.opponent().total)) {
			nilfgaard_wins_draws = player.deck.faction === "nilfgaard" && player.total === player.opponent().total;
			await player.passRound();
			return;
		}
		let data_max = this.getMaximums();
		let data_board = this.getBoardData();
		let weights = player.hand.cards.map(c =>
			({
				weight: this.weightCard(c, data_max, data_board),
				action: async () => await this.playCard(c, data_max, data_board),
				card: c
			}));
		if (player.leaderAvailable)
			weights.push({
				weight: this.weightLeader(player.leader, data_max, data_board),
				action: async () => {
					await ui.notification("op-leader", 1200);
					await player.activateLeader();
				}
			});
		weights.push({
			weight: this.weightPass(),
			action: async () => await player.passRound()
		});
		let weightTotal = weights.reduce((a, c) => a + c.weight, 0);
		if (weightTotal === 0) {
			for (let i = 0; i < player.hand.cards.length; ++i) {
				let card = player.hand.cards[i];
				if (card.row === "weather" && this.weightWeather(card) > -1 || card.abilities.includes("avenger")) {
					await weights[i].action();
					return;
				}
			}
			await player.passRound();
		} else {
			for (var i = 0; i < weights.length; ++i) {
				if (weights[i].card)
					console.log("[" + weights[i].card.name + "] Weight: " + weights[i].weight);
				else if (i == weights.length - 2)
					console.log("[Leader] Weight: " + weights[i].weight);
				else
					console.log("[Pass] Weight: " + weights[i].weight);
			}
			let rand = randomInt(weightTotal);
			console.log("Chosen weight: " + rand);
			for (var i = 0; i < weights.length; ++i) {
				rand -= weights[i].weight;
				if (rand < 0)
					break;
			}
			await weights[i].action();
		}
	}

	// Collects data about card with the hightest power on the board
	getMaximums() {
		let rmax = board.row.map(r => ({
			row: r,
			cards: r.cards.filter(c => c.isUnit()).reduce((a, c) =>
				(!a.length || a[0].power < c.power) ? [c] : a[0].power === c.power ? a.concat([c]) : a, [])
		}));

		let max = rmax.filter((r, i) => r.cards.length && i < 3).reduce((a, r) => Math.max(a, r.cards[0].power), 0);
		let max_me = rmax.filter((r, i) => i < 3 && r.cards.length && r.cards[0].power === max).reduce((a, r) =>
			a.concat(r.cards.map(c => ({
				row: r,
				card: c
			}))), []);

		max = rmax.filter((r, i) => r.cards.length && i > 2).reduce((a, r) => Math.max(a, r.cards[0].power), 0);
		let max_op = rmax.filter((r, i) => i > 2 && r.cards.length && r.cards[0].power === max).reduce((a, r) =>
			a.concat(r.cards.map(c => ({
				row: r,
				card: c
			}))), []);

		// Also compute for rows without a shield
		let rmax_noshield = rmax.filter((r, i) => !r.row.isShielded());
		let max_noshield = rmax_noshield.filter((r, i) => r.cards.length && i < 3).reduce((a, r) => Math.max(a, r.cards[0].power), 0);
		let max_me_noshield = rmax_noshield.filter((r, i) => i < 3 && r.cards.length && r.cards[0].power === max_noshield).reduce((a, r) =>
			a.concat(r.cards.map(c => ({
				row: r,
				card: c
			}))), []);

		max_noshield = rmax_noshield.filter((r, i) => r.cards.length && i > 2).reduce((a, r) => Math.max(a, r.cards[0].power), 0);
		let max_op_noshield = rmax_noshield.filter((r, i) => i > 2 && r.cards.length && r.cards[0].power === max_noshield).reduce((a, r) =>
			a.concat(r.cards.map(c => ({
				row: r,
				card: c
			}))), []);

		return {
			rmax: rmax,
			me: max_me,
			op: max_op,
			rmax_noshield: rmax_noshield,
			me_noshield: max_me_noshield,
			op_noshield: max_op_noshield
		};
	}

	// Collects data about the types of cards on the board and in each player's graves
	getBoardData() {
		let data = this.countCards(new CardContainer());
		Object.keys([0, 1, 2]).map(i => board.row[i]).forEach(r => this.countCards(r, data));
		data.grave_me = this.countCards(this.player.grave);
		data.grave_op = this.countCards(this.player.opponent().grave);
		return data;
	}

	// Catalogs the kinds of cards in a given CardContainer
	countCards(container, data) {
		data = data ? data : {
			spy: [],
			medic: [],
			bond: {},
			scorch: []
		};
		container.cards.filter(c => c.isUnit()).forEach(c => {
			for (let x of c.abilities) {
				if (!c.isLocked()) {
					switch (x) {
						case "spy":
						case "medic":
							data[x].push(c);
							break;
						case "scorch_r":
						case "scorch_c":
						case "scorch_s":
							data["scorch"].push(c);
							break;
						case "bond":
							if (!data.bond[c.target])
								data.bond[c.target] = 0;
							data.bond[c.target]++;
					}
				}
			}
		});
		return data;
	}

	// Swaps a card from the hand with the deck if beneficial
	redraw() {
		let card = this.discardOrder({
			holder: this.player
		}).shift();
		if (card && card.power < 15) {
			this.player.deck.swap(this.player.hand, this.player.hand.removeCard(card))
		}
	}

	// Orders discardable cards from most to least discardable
	discardOrder(card) {
		let cards = [];
		let groups = {};
		let musters = card.holder.hand.cards.filter(c => c.abilities.includes("muster"));
		while (musters.length > 0) {
			let curr = musters.pop();
			let i = curr.name.indexOf('-');
			let name = i === -1 ? curr.name : curr.name.substring(0, i).trim();
			if (!groups[name])
				groups[name] = [];
			let group = groups[name];
			group.push(curr);
			for (let j = musters.length - 1; j >= 0; j--)
				if (musters[j].name.startsWith(name))
					group.push(musters.splice(j, 1)[0]);
		}

		for (let group of Object.values(groups)) {
			group.sort(Card.compare);
			group.pop();
			cards.push(...group);
		}

		let weathers = card.holder.hand.cards.filter(c => c.row === "weather");
		if (weathers.length > 1) {
			weathers.splice(randomInt(weathers.length), 1);
			cards.push(...weathers);
		}

		let normal = card.holder.hand.cards.filter(c => c.abilities.length === 0);
		normal.sort(Card.compare);
		cards.push(...normal);
		return cards;
	}

	// Tells the Player that this object controls to play a card
	async playCard(c, max, data) {
		if (c.key === "spe_horn")
			await this.horn(c);
		else if (c.key === "spe_mardroeme")
			await this.mardroeme(c);
		else if (c.abilities.includes("decoy"))
			await this.decoy(c, max, data);
		else if (c.faction === "special" && c.abilities.includes("scorch"))
			await this.scorch(c, max, data);
		else if (c.faction === "special" && c.abilities.includes("cintra_slaughter"))
			await this.slaughterCintra(c);
		else if (c.faction === "special" && c.abilities.includes("seize"))
			await this.seizeCards(c);
		else if (c.faction === "special" && (c.abilities.includes("shield") || c.abilities.includes("shield_c") || c.abilities.includes("shield_r") || c.abilities.includes("shield_s")))
			await this.shieldCards(c);
		else if (c.faction === "special" && c.abilities.includes("lock"))
			await this.lock(c);
		else if (c.faction === "special" && c.abilities.includes("knockback"))
			await this.knockback(c);
		else if (c.faction === "special" && c.abilities.includes("toussaint_wine"))
			await this.toussaintWine(c);
		else if ((c.isUnit() || c.hero) && c.abilities.includes("witch_hunt"))
			await this.witchHunt(c);
		else
			await this.player.playCard(c);
	}

	// Plays a Commander's Horn to the most beneficial row. Assumes at least one viable row.
	async horn(card) {
		let rows = [0, 1, 2].map(i => board.row[i]).filter(r => !r.special.containsCardByKey("spe_horn")); 
		let max_row;
		let max = 0;
		for (let i = 0; i < rows.length; ++i) {
			let r = rows[i];
			let dif = [0, 0];
			this.calcRowPower(r, dif, true);
			r.effects.horn++;
			this.calcRowPower(r, dif, false);
			r.effects.horn--;
			let score = dif[1] - dif[0];
			if (max < score) {
				max = score;
				max_row = r;
			}
		}
		await this.player.playCardToRow(card, max_row);
	}

	// Plays a Mardroeme to the most beneficial row. Assumes at least one viable row.
	async mardroeme(card) { // TODO skellige
		let row, max = 0;
		for (let i = 1; i < 3; i++) {
			let curr = this.weightMardroemeRow(card, board.row[i]);
			if (curr > max) {
				max = curr;
				row = board.row[i];
			}
		}
		await this.player.playCardToRow(card, row);
	}

	// Selects a card to remove from a Grave. Assumes at least one valid card.
	medic(card, grave) {
		let data = this.countCards(grave);
		let targ;
		if (data.spy.length) {
			let min = data.spy.reduce((a, c) => Math.min(a, c.power), Number.MAX_VALUE);
			targ = data.spy.filter(c => c.power === min)[0];
		} else if (data.medic.length) {
			let max = data.medic.reduce((a, c) => Math.max(a, c.power), 0);
			targ = data.medic.filter(c => c.power === max)[0];
		} else if (data.scorch.length) {
			targ = data.scorch[randomInt(data.scorch.length)];
		} else {
			let units = grave.findCards(c => c.isUnit());
			targ = units.reduce((a, c) => a.power < c.power ? c : a, units[0]);
		}
		return targ;
	}

	// Selects a card to return to the Hand and replaces it with a Decoy. Assumes at least one valid card.
	async decoy(card, max, data) {
		let targ, row;
		if (game.decoyCancelled)
			return;
		let usable_data;
		if (card.row.length > 0) {
			// Units with decoy ability only work on a specific row
			if (card.row === "close" || card.row === "agile")
				usable_data = this.countCards(board.row[2], usable_data);
			if (card.row === "ranged" || card.row === "agile")
				usable_data = this.countCards(board.row[1], usable_data);
			if (card.row === "siege")
				usable_data = this.countCards(board.row[0], usable_data);
		} else {
			usable_data = data;
        }
		if (usable_data.spy.length) {
			let min = usable_data.spy.reduce((a, c) => Math.min(a, c.power), Number.MAX_VALUE);
			targ = usable_data.spy.filter(c => c.power === min)[0];
		} else if (usable_data.medic.length) {
			targ = usable_data.medic[randomInt(usable_data.medic.length)];
		} else if (usable_data.scorch.length) {
			targ = usable_data.scorch[randomInt(usable_data.scorch.length)];
		} else {
			let pairs = max.rmax.filter((r, i) => i < 3 && r.cards.length)
				.filter((r, i) => card.row.length === 0 || (["close", "agile"].includes(card.row) && i === 2) || (["ranged", "agile"].includes(card.row) && i === 1) || (card.row === "siege" && i === 0))
				.reduce((a, r) =>
				r.cards.map(c => ({
					r: r.row,
					c: c
				})).concat(a), []);
			
			if (pairs.length) {
				let pair = pairs[randomInt(pairs.length)];
				targ = pair.c;
				row = pair.r;
            }
		}

		if (targ) {
			for (let i = 0; !row; ++i) {
				if (board.row[i].cards.indexOf(targ) !== -1) {
					row = board.row[i];
					break;
				}
			}
			targ.decoyTarget = true;
			setTimeout(() => board.toHand(targ, row), 1000);
		} else {
			row = ["close", "agile"].includes(card.row) ? board.row[2] : card.row === "ranged" ? board.row[1] : board.row[0];
        }
		await this.player.playCardToRow(card, row);
	}

	// Tells the controlled Player to play the Scorch card
	async scorch(card, max, data) {
		await this.player.playScorch(card);
	}

	// Tells the controlled Player to play the Scorch card
	async slaughterCintra(card) {
		await this.player.playSlaughterCintra(card);
	}

	// Tells the controlled Player to play the seize special card
	async seizeCards(card) {
		await this.player.playSeize(card);
	}

	// Plays a shield special card to the most beneficial row. Assumes at least one viable row.
	// Also applicable for shield cards which affect only one row.
	async shieldCards(card) {
		if (card.abilities.includes("shield_c")) {
			await this.player.playCardToRow(card, board.row[2]);
			return;
		} else if (card.abilities.includes("shield_r")) {
			await this.player.playCardToRow(card, board.row[1]);
			return;
		} if (card.abilities.includes("shield_s")) {
			await this.player.playCardToRow(card, board.row[0]);
			return;
		}

		let units = card.holder.getAllRowCards().concat(card.holder.hand.cards).filter(c => c.isUnit()).filter(c => !c.abilities.includes("spy"));
		let rowStats = { "close": 0, "ranged": 0, "siege": 0, "agile": 0 };
		units.forEach(c => {
			rowStats[c.row] += c.power;
		});
		rowStats["close"] += rowStats["agile"];
		let max_row;
		if (rowStats["close"] >= rowStats["ranged"] && rowStats["close"] >= rowStats["siege"])
			max_row = board.row[2];
		else if (rowStats["ranged"] > rowStats["close"] && rowStats["ranged"] >= rowStats["siege"])
			max_row = board.row[1];
		else
			max_row = board.row[0];
		await this.player.playCardToRow(card, max_row);
	}

	// Plays the lock special card in the enemy melee row
	async lock(card) {
		await this.player.playCardToRow(card, board.row[3]);
	}

	// Plays the knockback special card in the most beneficial row - by default enemy melee row
	async knockback(card) {
		await this.player.playKnockback(card);
	}

	// Play special wine card to the most beneficial row.
	async toussaintWine(card) {
		await this.player.playCardToRow(card,this.bestRowToussaintWine(card));
	}

	// Play special wine card to the most beneficial row.
	async witchHunt(card) {
		await this.player.playCardToRow(card, this.bestWitchHuntRow(card).getOppositeRow());
	}

	bestWitchHuntRow(card) {
		if (card.row == "agile") {
			let rows = [3, 4].map(i => board.row[i]).filter(r => !r.isShielded() && !game.scorchCancelled).map(r => ({
				row: r,
				value: r.cards.filter(c => c.isUnit()).reduce((a, c) => a + c.power, 0)
			}));
			return rows.sort((a, b) => b.value - a.value)[0].row;
		} else {
            return board.getRow(card, card.row, card.holder).getOppositeRow();
        }
    }

	bestRowToussaintWine(card) {
		let units = card.holder.getAllRowCards().concat(card.holder.hand.cards).filter(c => c.isUnit()).filter(c => !c.abilities.includes("spy"));
		let rowStats = { "close": 0, "ranged": 0, "siege": 0, "agile": 0 };
		units.forEach(c => {
			rowStats[c.row] += 1;
		});
		rowStats["close"] += rowStats["agile"];
		let rows = card.holder.getAllRows();
		rowStats["close"] = rows[0].effects.toussaint_wine > 0 ? 0 : rowStats["close"];
		rowStats["ranged"] = rows[1].effects.toussaint_wine > 0 ? 0 : rowStats["ranged"];
		rowStats["siege"] = rows[2].effects.toussaint_wine > 0 ? 0 : rowStats["siege"];
		let max_row;
		if (rowStats["close"] >= rowStats["ranged"] && rowStats["close"] >= rowStats["siege"])
			max_row = board.row[2];
		else if (rowStats["ranged"] > rowStats["close"] && rowStats["ranged"] >= rowStats["siege"])
			max_row = board.row[1];
		else
			max_row = board.row[0];
		return max_row;
    }

	// Assigns a weight for how likely the conroller is to Pass the round
	weightPass() {
		if (this.player.health === 1)
			return 0;
		let dif = this.player.opponent().total - this.player.total;
		if (dif > 30)
			return 100;
		if (dif < -30 && this.player.opponent().handsize - this.player.handsize > 2)
			return 100;
		return Math.floor(Math.abs(dif));
	}

	// Assigns a weight for how likely the controller is to activate its leader ability
	weightLeader(card, max, data) {
		let w = ability_dict[card.abilities[0]].weight;
		if (ability_dict[card.abilities[0]].weight) {
			let score = w(card, this, max, data);
			return score;
		}
		return 10 + (game.roundCount - 1) * 15;
	}

	// Assigns a weight for how likely the controller will use a scorch-row card
	weightScorchRow(card, max, row_name) {
		if (game.scorchCancelled)
			return 0;
		let index = 3 + (row_name === "close" ? 0 : row_name === "ranged" ? 1 : 2);
		if (board.row[index].total < 10 || board.row[index].isShielded() )
			return 0;
		let score = max.rmax[index].cards.reduce((a, c) => a + c.power, 0);
		return score;
	}

	// Calculates a weight for how likely the controller will use horn on this row
	weightHornRow(card, row) {
		return row.special.containsCardByKey("spe_horn") ? 0 : this.weightRowChange(card, row);
	}

	// Calculates weight for playing a card on a given row, min 0
	weightRowChange(card, row) {
		return Math.max(0, this.weightRowChangeTrue(card, row));
	}

	// Calculates weight for playing a card on the given row
	weightRowChangeTrue(card, row) {
		let dif = [0, 0];
		this.calcRowPower(row, dif, true);
		row.updateState(card, true);
		this.calcRowPower(row, dif, false);
		if (!card.isSpecial())
			dif[0] -= row.calcCardScore(card);
		row.updateState(card, false);
		return dif[1] - dif[0];
	}

	// Calculates the weight for playing a weather card
	weightWeather(card) {
		let rows;
		if (card.abilities) {
			if (card.key === "spe_clear")
				rows = Object.values(weather.types).filter(t => t.count > 0).flatMap(t => t.rows);
			else
				rows = Object.values(weather.types).filter(t => t.count === 0 && t.name === card.abilities[0]).flatMap(t => t.rows);
		} else {
			if (card.ability == "clear")
				rows = Object.values(weather.types).filter(t => t.count > 0).flatMap(t => t.rows);
			else
				rows = Object.values(weather.types).filter(t => t.count === 0 && t.name === card.ability).flatMap(t => t.rows);
        }
		
		if (!rows.length)
			return 1;
		let dif = [0, 0];
		rows.forEach(r => {
			let state = r.effects.weather;
			this.calcRowPower(r, dif, true);
			r.effects.weather = !state;
			this.calcRowPower(r, dif, false);
			r.effects.weather = state;
		});
		return dif[1] - dif[0];
	}

	// Calculates the weight for playing a mardroeme card
	weightMardroemeRow(card, row) {
		if (card.key === "spe_mardroeme" && row.special.containsCardByKey("spe_mardroeme"))
			return 0;
		let ermion = card.holder.hand.cards.filter(c => c.key === "sk_ermion").length > 0;
		if (ermion && card.key !== "sk_ermion" && row === board.row[1])
			return 0;
		let bers_cards = row.cards.filter(c => c.abilities.includes("berserker"));
		let weightData = { bond: {}, strength:0 };

		for (var i = 0; i < bers_cards.length; i++) {
			var c = bers_cards[i];
			var ctarget = card_dict[c.target];
			weightData.strength -= c.power;
			if (ctarget.ability.includes("morale"))
				weightData.strength += Number(ctarget["strength"]) + row.cards.filter(c => c.isUnit()).length - 1;
			if (ctarget.ability.includes("bond")) {
				if (!weightData.bond[c.target])
					weightData.bond[c.target] = [0, Number(ctarget["strength"])];
				weightData.bond[c.target][0]++;
            }
		}
		let weight = weightData.strength + Object.keys(weightData.bond).reduce((s, c) => s + Math.pow(weightData.bond[c][0],2) * weightData.bond[c][1], 0)
		return Math.max(1, weight);
	}

	// Calculates the weight for cards with the medic ability
	weightMedic(data, score, owner) {
		let units = owner.grave.findCards(c => c.isUnit());
		let grave = data["grave_" + owner.opponent().tag];
		return !units.length ? Math.min(1, score) : score + (grave.spy.length ? 50 : grave.medic.length ? 15 : grave.scorch.length ? 10 : this.player.health === 1 ? 1 : 0);
	}

	// Calculates the weight for cards with the berserker ability
	weightBerserker(card, row, score) {
		if (card.holder.hand.cards.filter(c => c.abilities.includes("mardroeme")).length < 1 && !row.effects.mardroeme > 0)
			return score;
		score -= card.basePower;
		let ctarget = card_dict[card.target];
		if (ctarget.ability.includes("morale")) {
			score += Number(ctarget["strength"]) + row.cards.filter(c => c.isUnit()).length - 1;
		}
		else if (ctarget.ability.includes("bond")) {
			let n = 1;
			if (!row.effects.mardroeme)
				n += row.cards.filter(c => c.key === card.key).filter(c => !c.isLocked()).length;
			else
				n += row.cards.filter(c => c.key === card.target).filter(c => !c.isLocked()).length;
			score += Number(ctarget["strength"]) * (n * n);
		} else {
			score += Number(ctarget["strength"]);
        }
		/*
		if (card.key === "sk_berserker")
			score += card_dict["sk_vildkaarl"]["strength"] + row.cards.filter(c => c.isUnit()).length - 1;
		else if (card.key === "sk_drummond_berserker")
			score += card_dict["sk_vildkaarl"]["strength"] + row.cards.filter(c => c.isUnit()).length - 1;
		else if (card.key === "sk_young_berserker") {
			let n = 0;
			if (!row.effects.mardroeme)
				n = row.cards.filter(c => c.key === "sk_young_berserker").length;
			else
				n = row.cards.filter(c => c.key === "sk_young_vildkaarl").length;
			score = card_dict["sk_young_vildkaarl"]["strength"] * ( n * n );
		} else {
			score = card_dict[card.target]["strength"];
        }*/
		return Math.max(1, score);
	}

	// Calculates the weight for a weather card if played from the deck
	weightWeatherFromDeck(card, weather_id) {
		if (card.holder.deck.findCard(c => c.abilities.includes(weather_id)) === undefined)
			return 0;
		return this.weightCard({
			abilities: [weather_id],
			row: "weather"
		});
	}

	// Assigns a weights for how likely the controller with play a card from its hand
	weightCard(card, max, data) {
		let abi
		if (card.abilities) {
			abi = card.abilities;
		} else if (card["ability"]) {
			abi = card["ability"].split(" ");
		} else {
			abi = [];
			console.log("Missing abilities for card:");
			console.log(card);
		}
		if (abi.includes("decoy")) {
			if (card.row.length > 0) {
				let row_data;
				if (card.row === "close" || card.row === "agile")
					row_data = this.countCards(board.row[2], row_data);
				if (card.row === "ranged" || card.row === "agile")
					row_data = this.countCards(board.row[1], row_data);
				if (card.row === "siege")
					row_data = this.countCards(board.row[0], row_data);
				return game.decoyCancelled ? 0 : row_data.spy.length ? 50 : row_data.medic.length ? 15 : row_data.scorch.length ? 10 : max.me.length ? card.power : 0;
            } else
				return game.decoyCancelled ? 0 : data.spy.length ? 50 : data.medic.length ? 15 : data.scorch.length ? 10 : max.me.length ? 1 : 0;
		}
		if (abi.includes("horn")) {
			let rows = [0, 1, 2].map(i => board.row[i]).filter(r => !r.special.containsCardByKey("spe_horn"));
			if (!rows.length)
				return 0;
			rows = rows.map(r => this.weightHornRow(card, r));
			return Math.max(...rows) / 2;
		}

		if (abi) {
			if (abi.includes("scorch")) {
				if (game.scorchCancelled)
					return Math.max(0, card.power);
				let power_op = max.op_noshield.length ? max.op_noshield[0].card.power : 0;
				let power_me = max.me_noshield.length ? max.me_noshield[0].card.power : 0;
				let total_op = power_op * max.op_noshield.length;
				let total_me = power_me * max.me_noshield.length;
				return power_me > power_op ? 0 : power_me < power_op ? total_op : Math.max(0, total_op - total_me);
			}
			if (abi.includes("decoy")) {
				return game.decoyCancelled ? 0 : data.spy.length ? 50 : data.medic.length ? 15 : data.scorch.length ? 10 : max.me.length ? 1 : 0;
			}
			if (abi.includes("mardroeme")) {
				let rows = [0, 1, 2].map(i => board.row[i]);
				return Math.max(...rows.map(r => this.weightMardroemeRow(card, r)));
			}
			if (["cintra_slaughter", "seize", "lock", "shield", "knockback", "shield_c", "shield_r", "shield_s"].includes(abi.at(-1))) {
				return ability_dict[abi.at(-1)].weight(card);
			}
			if (abi.includes("witch_hunt")) {
				let best_row = this.bestWitchHuntRow(card)
				if (best_row)
					return best_row.minUnits().reduce((a, c) => a + c.power, 0) + card.power;
				return card.power
            }
			if (abi.includes("toussaint_wine")) {
				let units = card.holder.getAllRowCards().concat(card.holder.hand.cards).filter(c => c.isUnit()).filter(c => !c.abilities.includes("spy"));
				let rowStats = { "close": 0, "ranged": 0, "siege": 0, "agile": 0 };
				units.forEach(c => {
					rowStats[c.row] += 1;
				});
				rowStats["close"] += rowStats["agile"];
				let rows = card.holder.getAllRows();
				rowStats["close"] = rows[0].effects.toussaint_wine > 0 ? 0 : rowStats["close"];
				rowStats["ranged"] = rows[1].effects.toussaint_wine > 0 ? 0 : rowStats["ranged"];
				rowStats["siege"] = rows[2].effects.toussaint_wine > 0 ? 0 : rowStats["siege"];
				return 2 * Math.max(rowStats["close"], rowStats["ranged"], rowStats["siege"]);
			}
		}

		if (card.row === "weather" || (card.deck && card.deck.startsWith("weather"))) {
			return Math.max(0, this.weightWeather(card));
		}

		let row = board.getRow(card, card.row === "agile" ? "close" : card.row, this.player);
		let score = row.calcCardScore(card);
		switch (abi[abi.length - 1]) {
			case "bond":
			case "morale":
			case "horn":
				score = this.weightRowChange(card, row);
				break;
			case "medic":
				score = this.weightMedic(data, score, card.holder);
				break;
			case "spy":
				score = 15 + score;
				break;
			case "muster":
				let pred = c => c.target === card.target;
				let units = card.holder.hand.cards.filter(pred).concat(card.holder.deck.cards.filter(pred));
				score *= units.length;
				break;
			case "scorch_c":
				score = Math.max(1, this.weightScorchRow(card, max, "close"));
				break;
			case "scorch_r":
				score = Math.max(1, this.weightScorchRow(card, max, "ranged"));
				break;
			case "scorch_s":
				score = Math.max(1, this.weightScorchRow(card, max, "siege"));
				break;
			case "berserker":
				score = this.weightBerserker(card, row, score);
				break;
			case "avenger":
			case "avenger_kambi":
				return score + ability_dict[abi[abi.length - 1]].weight(card);
		}

		return score;
	}

	// Calculates the current power of a row associated with each Player
	calcRowPower(r, dif, add) {
		r.findCards(c => c.isUnit()).forEach(c => {
			let p = r.calcCardScore(c);
			c.holder === this.player ? (dif[0] += add ? p : -p) : (dif[1] += add ? p : -p);
		});
	}
}

var may_leader = true,
	exibindo_lider = false;

// Can make actions during turns like playing cards that it owns
class Player {
	constructor(id, name, deck) {
		this.id = id;
		this.tag = (id === 0) ? "me" : "op";
        this.controller = (id === 0) ? new Controller() : new ControllerAI(this);

		this.hand = (id === 0) ? new Hand(document.getElementById("hand-row")) : new HandAI();
		this.grave = new Grave(document.getElementById("grave-" + this.tag));
		this.deck = new Deck(deck.faction, document.getElementById("deck-" + this.tag));
		this.deck_data = deck;
		this.leader = new Card(deck.leader.index, deck.leader.card, this);
		this.elem_leader = document.getElementById("leader-" + this.tag);
		this.elem_leader.children[0].appendChild(this.leader.elem);

		this.reset();

		this.name = name;
		document.getElementById("name-" + this.tag).innerHTML = name;

        if (deck.title)
            document.getElementById("deck-name-" + this.tag).innerHTML = deck.title;
        else
		    document.getElementById("deck-name-" + this.tag).innerHTML = factions[deck.faction].name;
		document.getElementById("stats-" + this.tag).getElementsByClassName("profile-img")[0].children[0].children[0];
		let x = document.querySelector("#stats-" + this.tag + " .profile-img > div > div");
		x.style.backgroundImage = iconURL("deck_shield_" + deck.faction);
	}

	// Sets default values
	reset() {
		this.grave.reset();
		this.hand.reset();
		this.deck.reset();
		this.deck.initializeFromID(this.deck_data.cards, this);

		this.health = 2;
		this.total = 0;
		this.passed = false;
		this.handsize = 10;
		this.winning = false;
		this.factionAbilityUses = 0;
		this.effects = {
			"witchers": {}
		};

		// Handling Faction abilities: active or passive
		let factionAbility = factions[this.deck.faction];
		if (factionAbility["activeAbility"]) {
			// Init ability if need be
			if (factionAbility.factionAbilityInit) {
				factionAbility.factionAbilityInit(this);
            }
			this.updateFactionAbilityUses(factionAbility["abilityUses"]);

			document.getElementById("faction-ability-" + this.tag).classList.remove("hide");
			if (this.tag === "me")
				document.getElementById("faction-ability-" + this.tag).addEventListener("click", () => this.activateFactionAbility(), false);
		} else {
			document.getElementById("faction-ability-" + this.tag).classList.add("hide");
        }

		this.enableLeader();
		this.setPassed(false);
		document.getElementById("gem1-" + this.tag).classList.add("gem-on");
		document.getElementById("gem2-" + this.tag).classList.add("gem-on");
	}

	roundStartReset() {
		this.effects = {
			"witchers": {}
		};
    }

	// Returns the opponent Player
	opponent() {
		return board.opponent(this);
	}

	// Updates the player's total score and notifies the gamee
	updateTotal(n) {
		this.total += n;
		document.getElementById("score-total-" + this.tag).children[0].innerHTML = this.total;
		board.updateLeader();
	}

	// Puts the player in the winning state
	setWinning(isWinning) {
		if (this.winning ^ isWinning)
			document.getElementById("score-total-" + this.tag).classList.toggle("score-leader");
		this.winning = isWinning;
	}

	// Puts the player in the passed state
	setPassed(hasPassed) {
		if (this.passed ^ hasPassed)
			document.getElementById("passed-" + this.tag).classList.toggle("passed");
		this.passed = hasPassed;
	}

	// Sets up board for turn
	async startTurn() {
		document.getElementById("stats-" + this.tag).classList.add("current-turn");
		if (this.leaderAvailable)
			this.elem_leader.children[1].classList.remove("hide");

		if (this === player_me) {
			document.getElementById("pass-button").classList.remove("noclick");
			may_pass1 = true;
		}

		if (this.controller instanceof ControllerAI) {
			await this.controller.startTurn(this);
		}
	}

	// Passes the round and ends the turn
	passRound() {
        this.setPassed(true);
        ui.notification("op-pass", 1200);
		this.endTurn();
	}

	// Plays a scorch card
	async playScorch(card) {
		if(!game.scorchCancelled)
			await this.playCardAction(card, async () => await ability_dict["scorch"].activated(card));
	}

	// Plays a Slaughter of Cintra card
	async playSlaughterCintra(card) {
		await this.playCardAction(card, async () => await ability_dict["cintra_slaughter"].activated(card)); 
	}

	// Plays a Seize special card card
	async playSeize(card) {
		await this.playCardAction(card, async () => await ability_dict["seize"].activated(card));
	}

	// Plays a Knockback special card card, assuming 1 valid
	async playKnockback(card) {
		let best_row = board.row[3];
		//If melee row is empty, better target ranged
		if (board.row[3].cards.length === 0)
			best_row = board.row[4];
		// If siege has an active weather effect, better target ranged
		if (board.row[4].cards.length > 1 && board.row[5].effects.weather)
			best_row = board.row[4];
		// If ranged has a horn or shield effect, better target it
		if ((board.row[4].isShielded() || board.row[4].effects.horn > 0) && board.row[4].cards.length > 0)
			best_row = board.row[4];
		// If there are some bond units in the ranged row, better try to break it before it grows
		if (Object.keys(board.row[4].effects.bond).length > 0 && board.row[5].effects.horn === 0)
			best_row = board.row[4];
		await this.playCardAction(card, async () => await ability_dict["knockback"].activated(card, best_row));
    }

	// Plays a card to a specific row
	async playCardToRow(card, row) {
		await this.playCardAction(card, async () => await board.moveTo(card, row, this.hand));
	}

	// Plays a card to the board
	async playCard(card) {
		await this.playCardAction(card, async () => await card.autoplay(this.hand));
	}

	// Shows a preview of the card being played, plays it to the board and ends the turn
	async playCardAction(card, action) {
		ui.showPreviewVisuals(card);
		await sleep(1000);
		ui.hidePreview(card);
		await action();
		this.endTurn();
	}

	// Handles end of turn visuals and behavior the notifies the game
	endTurn() {
        if (!this.passed && !this.canPlay()) {
            this.setPassed(true);
            ui.notification("op-pass", 1200);
        }
		if (this === player_me) {
			document.getElementById("pass-button").classList.add("noclick");
			may_pass1 = false;
		}
		document.getElementById("stats-" + this.tag).classList.remove("current-turn");
		this.elem_leader.children[1].classList.add("hide");
		game.endTurn()
	}

	// Tells the the Player if it won the round. May damage health.
	endRound(win) {
		if (!win) {
			if (this.health < 1)
				return;
			document.getElementById("gem" + this.health + "-" + this.tag).classList.remove("gem-on");
			this.health--;
		}
		this.setPassed(false);
		this.setWinning(false);
	}

	// Returns true if the Player can make any action other than passing
	canPlay() {
		return this.hand.cards.length > 0 || this.leaderAvailable || this.factionAbilityUses > 0;
	}

	// Use a leader's Activate ability, then disable the leader
	async activateLeader() {
		try {
			Carousel.curr.cancel();
		} catch (err) {	}
		if (this.leaderAvailable) {
			called_leader = true;
			this.endTurnAfterAbilityUse = true;
			await this.leader.activated[0](this.leader, this);
			this.disableLeader();
			// Some abilities require further actions before ending the turn, such as selecting a card
			if (this.endTurnAfterAbilityUse)
				this.endTurn();
			else {
				// Make selections for AI player
				if (this.controller instanceof ControllerAI) {
					if (this.leader.key === "wu_alzur_maker") {
						let worse_unit = this.getAllRowCards().filter(c => c.isUnit()).sort((a, b) => a.power - b.power)[0];
						ui.selectCard(worse_unit);
					} else if (this.leader.key === "to_anna_henrietta_duchess") {
						let horns = player_me.getAllRows().filter(r => r.special.findCards(c => c.abilities.includes("horn")).length > 0).sort((a, b) => b.total - a.total);
						if (horns[0])
							ui.selectRow(horns[0]);
					} else if (this.leader.key === "lr_meve_princess" || this.leader.key === "sy_carlo_varese") {
						let max = this.controller.getMaximums();
						let rows = [this.controller.weightScorchRow(this.leader, max, "close"), this.controller.weightScorchRow(this.leader, max, "ranged"), this.controller.weightScorchRow(this.leader, max, "siege")];
						let maxv = 0, max_row;
						for (var i = 0; i < 3; i++) {
							if (rows[i] > maxv) {
								maxv = rows[i];
								max_row = board.row[3 + i];
							}
						}
						if (max_row)
							ui.selectRow(max_row);
					} else if (this.leader.key === "sy_cyrus_hemmelfart") {
						// We select a random row to put shackles on
						ui.selectRow(board.row[3+randomInt(2)]);
					}
				} 
            }
		}
	}

	// Disable access to leader ability and toggles leader visuals to off state
	disableLeader() {
		this.leaderAvailable = false;
		let elem = this.elem_leader.cloneNode(true);
		this.elem_leader.parentNode.replaceChild(elem, this.elem_leader);
		this.elem_leader = elem;
		this.elem_leader.children[0].classList.add("fade");
		this.elem_leader.children[1].classList.add("hide");
		this.elem_leader.addEventListener("click", async () => await ui.viewCard(this.leader), false);
	}

	// Enable access to leader ability and toggles leader visuals to on state
	enableLeader() {
		this.leaderAvailable = this.leader.activated.length > 0;
		let elem = this.elem_leader.cloneNode(true);
		this.elem_leader.parentNode.replaceChild(elem, this.elem_leader);
		this.elem_leader = elem;
		this.elem_leader.children[0].classList.remove("fade");
		this.elem_leader.children[1].classList.remove("hide");

		if (this.id === 0 && this.leader.activated.length > 0) {
			this.elem_leader.children[0].addEventListener("click",
				async () => await ui.viewCard(this.leader, async () => await this.activateLeader()),
					false
			);
			this.elem_leader.children[0].addEventListener("mouseover", function() {
				tocar("card", false);
				this.style.boxShadow = "0 0 1.5vw #6d5210"
			});
			this.elem_leader.children[0].addEventListener("mouseout", function() {
				this.style.boxShadow = "0 0 0 #6d5210"
			});
			
			window.addEventListener("keydown", function(e) {
				if (may_leader && may_pass1) {
					if (e.keyCode == 88) {
						if (exibindo_lider) {
							exibindo_lider = false;
							player_me.activateLeader();
						} else if (!called_leader) {
							may_leader = false;
							exibindo_lider = true;
							player_me.callLeader();
						}
					}
				}
			});
			window.addEventListener("keyup", function (e) {
				if (player_me.leaderAvailable) may_leader = true;
			});
		} else {
			this.elem_leader.children[0].addEventListener("click", async () => await ui.viewCard(this.leader), false);
			this.elem_leader.children[0].addEventListener("mouseover", function() {});
			this.elem_leader.children[0].addEventListener("mouseout", function() {});
		}
		// TODO set crown color
	}
	
	async callLeader() {
		await ui.viewCard(player_me.leader, async () => await player_me.activateLeader());
	}

	async activateFactionAbility() {
		let factionData = factions[this.deck.faction];
		if (factionData.activeAbility && this.factionAbilityUses > 0) {
			await ui.popup("Use faction ability [E]", () => this.useFactionAbility(), "Cancel [Q]", () => this.escapeFactionAbility(), "Would you like to use your faction ability?", "Faction ability: " + factionData.description);
		}
		return;
    }

	async useFactionAbility() {
		let factionData = factions[this.deck.faction];
		if (factionData.activeAbility && this.factionAbilityUses > 0) {
			this.endTurnAfterAbilityUse = true;
			await factionData.factionAbility(this);
			this.updateFactionAbilityUses(this.factionAbilityUses - 1);
			// Some faction abilities require extra interractions
			if (this.endTurnAfterAbilityUse)
				this.endTurn();
		}
		return;
	}

	// Called when chose to not play the faction ability
	async escapeFactionAbility() {
		ui.enablePlayer(true);
	}

	updateFactionAbilityUses(count) {
		this.factionAbilityUses = Math.max(0,count);
		document.getElementById("faction-ability-count-" + this.tag).innerHTML = this.factionAbilityUses;
		if (this.factionAbilityUses === 0) {
			document.getElementById("faction-ability-" + this.tag).classList.add("fade");
		} else {
			document.getElementById("faction-ability-" + this.tag).classList.remove("fade");
        }
	}

	// Get all rows for this player, sorted to have close > ranged > siege
	getAllRows() {
		if (this === player_me) {
			return board.row.filter((r, i) => i > 2);
		}
		return board.row.filter((r, i) => i < 3).reverse();
	}

	//Get all cards in rows for this player
	getAllRowCards() {
		return this.getAllRows().reduce((a, r) => r.cards.concat(a), []);
    }
}

var called_leader = false;

function alteraClicavel(obj, add) {
	try {
		if (!add && fileira_clicavel.elem.id == obj.elem.id) fileira_clicavel = null;
		else fileira_clicavel = obj;
	} catch (err) {}
}

// Handles the adding, removing and formatting of cards in a container
class CardContainer {
	constructor(elem) {
		this.elem = elem;
		this.cards = [];
	}

	// Indicates whether or not this container contains any card
	isEmpty() {
		return this.cards.length === 0;
	}

	// Returns the first card that satisfies the predcicate. Does not modify container.
	findCard(predicate) {
		for (let i = this.cards.length - 1; i >= 0; --i)
			if (predicate(this.cards[i]))
				return this.cards[i];
	}

	// Returns a list of cards that satisfy the predicate. Does not modify container.
	findCards(predicate) {
		return this.cards.filter(predicate);
	}

	// Indicates whether or not the card with given Key can be found in container
	containsCardByKey(key) {
		return (this.findCards(c => c.key === key).length) > 0; 
    }

	// Returns a list of up to n cards that satisfy the predicate. Does not modify container.
	findCardsRandom(predicate, n) {
		let valid = predicate ? this.cards.filter(predicate) : this.cards;
		if (valid.length === 0)
			return [];
		if (!n || n === 1)
			return [valid[randomInt(valid.length)]];
		let out = [];
		for (let i = Math.min(n, valid.length); i > 0; --i) {
			let index = randomInt(valid.length);
			out.push(valid.splice(index, 1)[0]);
		}
		return out;
	}

	// Removes and returns a list of cards that satisy the predicate.
	getCards(predicate) {
		return this.cards.reduce((a, c, i) => (predicate(c, i) ? [i] : []).concat(a), []).map(i => this.removeCard(i));
	}

	// Removes and returns a card that satisfies the predicate.
	getCard(predicate) {
		for (let i = this.cards.length - 1; i >= 0; --i)
			if (predicate(this.cards[i]))
				return this.removeCard(i);
	}

	// Removes and returns any cards up to n that satisfy the predicate.
	getCardsRandom(predicate, n) {
		return this.findCardsRandom(predicate, n).map(c => this.removeCard(c));
	}

	// Adds a card to the container along with its associated HTML element.
	addCard(card, index) {
		this.cards.push(card);
		this.addCardElement(card, index ? index : 0);
		this.resize();
		card.currentLocation = this;
	}

	// Removes a card from the container along with its associated HTML element.
	removeCard(card, index) {
		if (this.cards.length === 0)
			throw "Cannot draw from empty " + this.constructor.name;
		card = this.cards.splice(isNumber(card) ? card : this.cards.indexOf(card), 1)[0];
		this.removeCardElement(card, index ? index : 0);
		this.resize();
		return card;
	}

	// Adds a card to a pre-sorted CardContainer
	addCardSorted(card) {
		let i = this.getSortedIndex(card);
		this.cards.splice(i, 0, card);
		return i;
	}

	// Returns the expected index of a card in a sorted CardContainer
	getSortedIndex(card) {
		for (var i = 0; i < this.cards.length; ++i)
			if (Card.compare(card, this.cards[i]) < 0)
				break;
		return i;
	}

	// Adds a card to a random index of the CardContainer
	addCardRandom(card) {
		this.cards.push(card);
		let index = randomInt(this.cards.length);
		if (index !== this.cards.length - 1) {
			let t = this.cards[this.cards.length - 1];
			this.cards[this.cards.length - 1] = this.cards[index];
			this.cards[index] = t;
		}
		return index;
	}

	// Removes the HTML elemenet associated with the card from this CardContainer
	removeCardElement(card, index) {
		if (this.elem)
			this.elem.removeChild(card.elem);
	}

	// Adds the HTML elemenet associated with the card to this CardContainer
	addCardElement(card, index) {
		if (this.elem) {
			if (index === this.cards.length)
				thise.elem.appendChild(card.elem);
			else
				this.elem.insertBefore(card.elem, this.elem.children[index]);
		}
	}

	// Empty function to be overried by subclasses that resize their content
	resize() {}

	// Modifies the margin of card elements inside a row-like container to stack properly
	resizeCardContainer(overlap_count, gap, coef) {
		let n = this.elem.children.length;
		let param = (n < overlap_count) ? "" + gap + "vw" : defineCardRowMargin(n, coef);
		let children = this.elem.getElementsByClassName("card");
		for (let x of children)
			x.style.marginLeft = x.style.marginRight = param;

		function defineCardRowMargin(n, coef = 0) {
			return "calc((100% - (4.45vw * " + n + ")) / (2*" + n + ") - (" + coef + "vw * " + n + "))";
		}
	}

	// Allows the row to be clicked
	setSelectable() {
		this.elem.classList.add("row-selectable");
		alteraClicavel(this, true);
	}

	// Disallows the row to be clicked
	clearSelectable() {
		this.elem.classList.remove("row-selectable");
		alteraClicavel(this, false);
		for (card in this.cards)
			card.elem.classList.add("noclick");
	}

	// Returns the container to its default, empty state
	reset() {
		while (this.cards.length)
			this.removeCard(0);
		if (this.elem)
			while (this.elem.firstChild)
				this.elem.removeChild(this.elem.firstChild);
		this.cards = [];
	}

}

// Contians all used cards in the order that they were discarded
class Grave extends CardContainer {
	constructor(elem) {
		super(elem)
		elem.addEventListener("click", () => ui.viewCardsInContainer(this), false);
	}

	// Override
	addCard(card) {
		this.setCardOffset(card, this.cards.length);
		super.addCard(card, this.cards.length);
	}

	// Override
	removeCard(card) {
		let n = isNumber(card) ? card : this.cards.indexOf(card);
		return super.removeCard(card, n);
	}

	// Override
	removeCardElement(card, index) {
		card.elem.style.left = "";
		for (let i = index; i < this.cards.length; ++i) this.setCardOffset(this.cards[i], i);
		super.removeCardElement(card, index);
	}

	// Offsets the card element in the deck
	setCardOffset(card, n) {
		card.elem.style.left = -0.03 * n + "vw";
	}
}

// Contians all special cards for a given row
class RowSpecial extends CardContainer {
	constructor(elem,row) {
		super(elem)
		this.row = row;
	}

	// Override
	addCard(card) {
		this.setCardOffset(card, this.cards.length);
		super.addCard(card, this.cards.length);
	}

	// Override
	removeCard(card) {
		let n = isNumber(card) ? card : this.cards.indexOf(card);
		return super.removeCard(card, n);
	}

	// Override
	removeCardElement(card, index) {
		card.elem.style.left = "";
		for (let i = index; i < this.cards.length; ++i) this.setCardOffset(this.cards[i], i);
		super.removeCardElement(card, index);
	}

	// Offsets the card element in the deck
	setCardOffset(card, n) {
		card.elem.style.left = (1+n) + "vw";
	}

}

// Contains a randomized set of cards to be drawn from
class Deck extends CardContainer {
	constructor(faction, elem) {
		super(elem);
		this.faction = faction;

		this.counter = document.createElement("div");
		this.counter.classList = "deck-counter center";
		this.counter.appendChild(document.createTextNode(this.cards.length));
		this.elem.appendChild(this.counter);
	}

	// Creates duplicates of cards with a count of more than one, then initializes deck
	initializeFromID(card_id_list, player) {
		this.initialize(card_id_list.reduce((a, c) => a.concat(clone(c.count, c)), []), player);

		function clone(n, elem) {
			for (var i = 0, a = []; i < n; ++i) a.push(elem);
			return a;
		}
	}

	// Populates a this deck with a list of card data and associated those cards with the owner of this deck.
	initialize(card_data_list, player) {
		for (let i = 0; i < card_data_list.length; ++i) {
			let card = new Card(card_data_list[i].index, card_dict[card_data_list[i].index], player);
			card.holder = player;
			this.addCardRandom(card);
			this.addCardElement();
		}
		this.resize();
	}

	// Override
	addCard(card) {
		this.addCardRandom(card);
		this.addCardElement();
		this.resize();
	}

	// Sends the top card to the passed hand
	async draw(hand) {
		tocar("game_buy", false);
		if (hand === player_op.hand)
			hand.addCard(this.removeCard(0));
		else
			await board.toHand(this.cards[0], this);
	}

	// Draws a card and sends it to the container before adding a card from the container back to the deck.
	swap(container, card) {
		container.addCard(this.removeCard(0));
		this.addCard(card);
	}

	// Override
	addCardElement() {
		let elem = document.createElement("div");
		elem.classList.add("deck-card");
		elem.style.backgroundImage = iconURL("deck_back_" + this.faction, "jpg");
		this.setCardOffset(elem, this.cards.length - 1);
		this.elem.insertBefore(elem, this.counter);
	}

	// Override
	removeCardElement() {
		this.elem.removeChild(this.elem.children[this.cards.length]).style.left = "";
	}

	// Offsets the card element in the deck
	setCardOffset(elem, n) {
		elem.style.left = -0.03 * n + "vw";
	}

	// Override
	resize() {
		this.counter.innerHTML = this.cards.length;
		this.setCardOffset(this.counter, this.cards.length);
	}

	// Override
	reset() {
		super.reset();
		this.elem.appendChild(this.counter);
	}
}

// Hand used by computer AI. Has an offscreen HTML element for card transitions.
class HandAI extends CardContainer {
	constructor() {
		super(undefined);
		this.counter = document.getElementById("hand-count-op");
		this.hidden_elem = document.getElementById("hand-op");
	}
	resize() {
		this.counter.innerHTML = this.cards.length;
	}
}

// Hand used by current player
class Hand extends CardContainer {
	constructor(elem) {
		super(elem);
		this.counter = document.getElementById("hand-count-me");
	}

	// Override
	addCard(card) {
		let i = this.addCardSorted(card);
		this.addCardElement(card, i);
		this.resize();
	}

	// Override
	resize() {
		this.counter.innerHTML = this.cards.length;
		this.resizeCardContainer(11, 0.075, .00225);
	}
}

var may_act_card = true;

// Contains active cards and effects. Calculates the current score of each card and the row.
class Row extends CardContainer {
	constructor(elem) {
		super(elem.getElementsByClassName("row-cards")[0]);
		this.elem_parent = elem;
		this.special = new RowSpecial(elem.getElementsByClassName("row-special")[0],this);
		this.total = 0;
		this.effects = {
			weather: false,
			bond: {},
			morale: 0,
			horn: 0,
			mardroeme: 0,
			shield: 0,
			lock: 0,
			toussaint_wine: 0
		};
		this.halfWeather = false;
		this.elem.addEventListener("click", () => ui.selectRow(this), true);
		this.elem.addEventListener("mouseover", function() {
			if (hover_row) {
				tocar("card", false);
				this.style.boxShadow = "0 0 1.5vw #6d5210";
			}
		});
		this.elem.addEventListener("mouseout", function() {
			this.style.boxShadow = "0 0 0 #6d5210"
		});
		window.addEventListener("keydown", function (e) {
			if (e.keyCode == 13 && fileira_clicavel !== null && may_act_card) {
				ui.selectRow(fileira_clicavel);
				may_act_card = false;
				fileira_clicavel = null;
			}
		});
		window.addEventListener("keyup", function (e) {
			if (e.keyCode == 13) may_act_card = true;
		});
		this.special.elem.addEventListener("click", () => ui.selectRow(this,true), false, true);
	}

	// Override
	async addCard(card, runEffect = true) {
		if (card.isSpecial()) {
			this.special.addCard(card);
		} else {
			let index = this.addCardSorted(card);
			this.addCardElement(card, index);
			this.resize();
		}
		card.currentLocation = this;
		if (this.effects.lock && card.isUnit() && card.abilities.length) {
			card.locked = true;
			this.effects.lock = Math.max(this.effects.lock - 1, 0);
			let lock_card = this.special.findCard(c => c.abilities.includes("lock"));
			// If several units arrive at the same time, it can be triggered several times, so we first remove the lock before doing animations
			if (lock_card)
				await board.toGrave(lock_card, this.special);
			await card.animate("lock")
        }
		if (runEffect && !card.isLocked()) {
			this.updateState(card, true);
			for (let x of card.placed)
				await x(card, this);
		}
		card.elem.classList.add("noclick");
		await sleep(600);
		this.updateScore();
	}

	// Override
	removeCard(card,runEffect=true) {
		// TODO: This case should no longer happen
		if (isNumber(card) && card === -1) {
			card = this.special.cards[0];
			this.special.reset();
			return card;
        }
		card = isNumber(card) ? this.cards[card] : card;
		if (card.isSpecial()) {
			this.special.removeCard(card);
		} else {
			super.removeCard(card);
			card.resetPower();
			card.locked = false;
		}
		this.updateState(card, false);
		if (runEffect) {
			if (!card.decoyTarget) {
				for (let x of card.removed)
					x(card);
			} else {
				card.decoyTarget = false;
            }
			
        }
		this.updateScore();
		return card;
	}

	// Override
	removeCardElement(card, index) {
		super.removeCardElement(card, index);
		let x = card.elem;
		x.style.marginLeft = x.style.marginRight = "";
		x.classList.remove("noclick");
	}

	// Updates a card's effect on the row
	updateState(card, activate) {
		for (let x of card.abilities) {
			if (!card.isLocked()) {
				switch (x) {
					case "morale":
					case "horn":
					case "mardroeme":
					case "lock":
					case "toussaint_wine":
						this.effects[x] += activate ? 1 : -1;
						break;
					case "shield":
					case "shield_c":
					case "shield_r":
					case "shield_s":
						if (activate)
							Promise.all(this.cards.filter(c => c.isUnit()).map(c => c.animate("shield")));
						this.effects["shield"] += activate ? 1 : -1;
						break;
					case "bond":
						if (!this.effects.bond[card.target])
							this.effects.bond[card.target] = 0;
						this.effects.bond[card.target] += activate ? 1 : -1;
						break;
				}
			}
		}
	}

	// Activates weather effect and visuals
	addOverlay(overlay) {
		var som = overlay == "fog" || overlay == "rain" ? overlay : overlay == "frost" ? "cold" : "";
		if (som != "") tocar(som, false);
		this.effects.weather = true;
		this.elem_parent.getElementsByClassName("row-weather")[0].classList.add(overlay);
		this.updateScore();
	}

	// Deactivates weather effect and visuals
	removeOverlay(overlay) {
		this.effects.weather = false;
		this.elem_parent.getElementsByClassName("row-weather")[0].classList.remove(overlay);
		this.updateScore();
	}

	// Override
	resize() {
		this.resizeCardContainer(10, 0.075, .00325);
	}

	// Updates the row's score by summing the current power of its cards
	updateScore() {
		let total = 0;
		for (let card of this.cards) {
			total += this.cardScore(card);
		}
		let player = this.elem_parent.parentElement.id === "field-op" ? player_op : player_me;
		player.updateTotal(total - this.total);
		this.total = total;
		this.elem_parent.getElementsByClassName("row-score")[0].innerHTML = this.total;
	}

	// Calculates and set the card's current power
	cardScore(card) {
		let total = this.calcCardScore(card);
		card.setPower(total);
		return total;
	}

	// Calculates the current power of a card affected by row affects
	calcCardScore(card) {
		if (card.key === "spe_decoy")
			return 0;
		let total = card.basePower;
		if (card.hero)
			return total;
		if (card.abilities.includes("spy"))
			total = Math.floor(game.spyPowerMult * total);
		if (this.effects.weather)
			if (this.halfWeather)
				total = Math.max(1, Math.floor(total/2));
			else
				total = Math.min(1, total);
		// Bond
		let bond = this.effects.bond[card.target];
		if (isNumber(bond) && bond > 1 && !card.isLocked())
			total *= Number(bond);
		// Morale
		total += Math.max(0, this.effects.morale + (card.abilities.includes("morale") ? -1 : 0));
		// Toussiant Wine
		total += Math.max(0, 2 * this.effects.toussaint_wine);
		//Witcher Schools
		if (card.abilities.at(-1) && card.abilities.at(-1).startsWith("witcher_") && !card.isLocked()) {
			let school = card.abilities.at(-1);
			if (card.holder.effects["witchers"][school]) {
				total += card.holder.effects["witchers"][school] - 1;
            }
        }
		// Horn
		if (this.effects.horn - (card.abilities.includes("horn") ? 1 : 0) > 0)
			total *= 2;
		return total;
	}

	// Applies a temporary leader horn affect that is removed at the end of the round
	async leaderHorn() {
		if (this.special.containsCardByKey("spe_horn"))
			return;
		let horn = new Card("spe_horn", card_dict["spe_horn"], null);
		await this.addCard(horn);
		game.roundEnd.push(() => this.removeCard(horn));
	}

	// Applies a local scorch effect to this row
	async scorch() {
		if (this.total >= 10 && !this.isShielded() && !game.scorchCancelled)
			await Promise.all(this.maxUnits().map(async c => {
				await c.animate("scorch", true, false);
				await board.toGrave(c, this);
			}));
	}

	// Removes all cards and effects from this row
	clear() {
		this.special.cards.filter(c => !c.noRemove).forEach(c => board.toGrave(c, this));
		this.cards.filter(c => !c.noRemove).forEach(c => board.toGrave(c, this));
	}

	// Returns all regular unit cards with the heighest power
	maxUnits() {
		let max = [];
		for (let i = 0; i < this.cards.length; ++i) {
			let card = this.cards[i];
			if (!card.isUnit())
				continue;
			if (!max[0] || max[0].power < card.power)
				max = [card];
			else if (max[0].power === card.power)
				max.push(card);
		}
		return max;
	}

	minUnits() {
		let min = [];
		for (let i = 0; i < this.cards.length; ++i) {
			let card = this.cards[i];
			if (!card.isUnit())
				continue;
			if (!min[0] || min[0].power > card.power)
				min = [card];
			else if (min[0].power === card.power)
				min.push(card);
		}
		return min;
    }

	// Override
	reset() {
		super.reset();
		this.special.reset();
		this.total = 0;
		this.effects = {
			weather: false,
			bond: {},
			morale: 0,
			horn: 0,
			mardroeme: 0,
			shield: 0,
			lock: 0,
			toussaint_wine: 0
		};
	}

	// Indicates whether or not a shield is protecting that row from abilities (does not protect from weather effects though)
	isShielded() {
		return (this.effects.shield > 0);
	}

	// True if at least 1 unit and total of power >= 10
	canBeScorched() {
		if (game.scorchCancelled)
			return false;
		return (this.cards.reduce((a, c) => a + c.power, 0) >= 10) && (this.cards.filter(c => c.isUnit()).length > 0);
	}

	// Return the index of the current row in the list of rows on the board
	getRowIndex() {
		for (let i = 0; i < board.row.length; i++) {
			if (board.row[i] === this)
				return i;
        }
		return -1;
	}

	// Returns the opposite Row object - the one on the opponent's side of the field
	getOppositeRow() {
		let index = 5 - this.getRowIndex();
		if (index >= 0 && index < board.row.length)
			return board.row[index]
		return null;
    }
}

// Handles how weather effects are added and removed
class Weather extends CardContainer {
	constructor(elem) {
		super(document.getElementById("weather"));
		this.types = {
			rain: {
				name: "rain",
				count: 0,
				rows: []
			},
			fog: {
				name: "fog",
				count: 0,
				rows: []
			},
			frost: {
				name: "frost",
				count: 0,
				rows: []
			}
		}
		let i = 0;
		for (let key of Object.keys(this.types))
			this.types[key].rows = [board.row[i], board.row[5 - i++]];

		this.elem.addEventListener("click", () => ui.selectRow(this), false);
	}

	// Adds a card if unique and clears all weather if 'clear weather' card added
	async addCard(card,withEffects=true) {
		super.addCard(card);
		card.elem.classList.add("noclick");
		if (!withEffects)
			return;
		if (card.key === "spe_clear") {
			// TODO Sunlight animation
			tocar("clear", false);
			await sleep(500);
			this.clearWeather();
		} else {
			this.changeWeather(card, x => ++this.types[x].count === 1, (r, t) => r.addOverlay(t.name));
			for (let i = this.cards.length - 2; i >= 0; --i) {
				if (card.name === this.cards[i].name) {
					await sleep(750);
					await board.toGrave(card, this);
					break;
				}
			}
		}
		await sleep(750);
	}

	// Override
	removeCard(card, withEffects = true) {
		card = super.removeCard(card);
		card.elem.classList.remove("noclick");
		if (withEffects)
			this.changeWeather(card, x => --this.types[x].count === 0, (r, t) => r.removeOverlay(t.name));
		return card;
	}

	// Checks if a card's abilities are a weather type. If the predicate is met, perfom the action
	// on the type's associated rows
	changeWeather(card, predicate, action) {
		for (let x of card.abilities) {
			if (x in this.types && predicate(x)) {
				for (let r of this.types[x].rows)
					action(r, this.types[x]);
			}
		}
	}

	// Removes all weather effects and cards
	async clearWeather() {
		await Promise.all(this.cards.map((c, i) => this.cards[this.cards.length - i - 1]).map(c => board.toGrave(c, this)));
	}

	// Override
	resize() {
		this.resizeCardContainer(4, 0.075, .045);
	}

	// Override
	reset() {
		super.reset();
		Object.keys(this.types).map(t => this.types[t].count = 0);
	}
}

// 
class Board {
	constructor() {
		this.op_score = 0;
		this.me_score = 0;
		this.row = [];
		for (let x = 0; x < 6; ++x) {
			let elem = document.getElementById((x < 3) ? "field-op" : "field-me").children[x % 3];
			this.row[x] = new Row(elem);
		}
	}

	// Get the opponent of this Player
	opponent(player) {
		return player === player_me ? player_op : player_me;
	}

	// Sends and translates a card from the source to the Deck of the card's holder
	async toDeck(card, source) {
		tocar("discard", false);
		await this.moveTo(card, "deck", source);
	}

	// Sends and translates a card from the source to the Grave of the card's holder
	async toGrave(card, source) {
		await this.moveTo(card, "grave", source);
	}

	// Sends and translates a card from the source to the Hand of the card's holder
	async toHand(card, source) {
		await this.moveTo(card, "hand", source);
	}

	// Sends and translates a card from the source to Weather
	async toWeather(card, source) {
		await this.moveTo(card, weather, source);
	}

	// Sends and translates a card from the source to the Deck of the card's combat row
	async toRow(card, source) {
		let row = (card.row === "agile") ? "close" : card.row ? card.row : "close";
		await this.moveTo(card, row, source);
	}

	// Sends and translates a card from the source to a specified row name or CardContainer
	async moveTo(card, dest, source) {
		if (isString(dest)) dest = this.getRow(card, dest);
		try {
			cartaNaLinha(dest.elem.id, card);
		} catch(err) {}
		await translateTo(card, source ? source : null, dest);
		if (dest instanceof Row || dest instanceof Weather)
			await dest.addCard(source ? source.removeCard(card) : card);	//Only the override in the Row/Weather classes are asynchronous
		else
			dest.addCard(source ? source.removeCard(card) : card);
	}

	// Sends and translates a card from the source to a specified row name or CardContainer - NO EFFECTS/ABILITIES
	async moveToNoEffects(card, dest, source) {
		if (isString(dest)) dest = this.getRow(card, dest);
		try {
			cartaNaLinha(dest.elem.id, card);
		} catch (err) { }
		await translateTo(card, source ? source : null, dest);
		if (dest instanceof Row || dest instanceof Weather)
			await dest.addCard(source ? source.removeCard(card,false) : card,false);	//Only the override in the Row/Weather classes are asynchronous
		else
			dest.addCard(source ? source.removeCard(card) : card);
	}

	// Sends and translates a card from the source to a row name associated with the passed player
	async addCardToRow(card, row_name, player, source) {
		let row;
		if (row_name instanceof Row) {
			row = row_name;
		} else {
			row = this.getRow(card, row_name, player);
        }
		try {
			cartaNaLinha(row.elem.id, card);
		} catch(err) {}
		await translateTo(card, source, row);
		await row.addCard(card);
	}

	// Returns the Card associated with the row name that the card would be sent to
	getRow(card, row_name, player) {
		player = player ? player : card ? card.holder : player_me;
		let isMe = player === player_me;
		if (!card.abilities) {
			console.log("Abilities missing for card:");
			console.log(card);
        }
		let isSpy = card.abilities.includes("spy");
		switch (row_name) {
			case "weather":
				return weather;
				break;
			case "close":
				return this.row[isMe ^ isSpy ? 3 : 2];
			case "ranged":
				return this.row[isMe ^ isSpy ? 4 : 1];
			case "siege":
				return this.row[isMe ^ isSpy ? 5 : 0];
			case "grave":
				return player.grave;
			case "deck":
				return player.deck;
			case "hand":
				return player.hand;
			default:
				console.error(card.name + " sent to incorrect row \"" + row_name + "\" by " + card.holder.name);
		}
	}

	// Updates which player currently is in the lead
	updateLeader() {
		let dif = player_me.total - player_op.total;
		player_me.setWinning(dif > 0);
		player_op.setWinning(dif < 0);
	}

	updateScores() {
		this.row.map(r => r.cards.map(c => r.cardScore(c)));
    }
}

function limpar() {
	fileira_clicavel = null;
	load_pass = load_passT;
	may_pass1 = false;
	may_pass2 = "";
	may_pass3 = true;
	timer2 = null;
	lCard = null;
}

class Game {
	constructor() {
		this.endScreen = document.getElementById("end-screen");
		let buttons = this.endScreen.getElementsByTagName("button");
		this.customize_elem = buttons[0];
		this.replay_elem = buttons[1];
		this.customize_elem.addEventListener("click", () => this.returnToCustomization(), false);
		this.replay_elem.addEventListener("click", () => this.restartGame(), false);
		this.reset();
		this.randomOPDeck = true;
	}

	reset() {
		this.firstPlayer;
		this.currPlayer = null;

		this.gameStart = [];
		this.roundStart = [];
		this.roundEnd = [];
		this.turnStart = [];
		this.turnEnd = [];

		this.roundCount = 0;
		this.roundHistory = [];

		this.randomRespawn = false;
		this.medicCount = 1;
		this.spyPowerMult = 1;
		this.decoyCancelled = false;
		this.scorchCancelled = false;

		// Also resetting some board/row properties affected during the course of a game
		if (board) {
			if (board.row) {
				board.row.forEach(r => {
					r.halfWeather = false;
				});
            }
        }

		weather.reset();
		board.row.forEach(r => r.reset());
	}

	// Sets up player faction abilities and psasive leader abilities
	initPlayers(p1, p2) {
		let l1 = ability_dict[p1.leader.abilities[0]];
		let l2 = ability_dict[p2.leader.abilities[0]];
		let special_abilities = {
			emhyr_whiteflame: false,
			meve_white_queen: false
		};
		if (l1 === ability_dict["emhyr_whiteflame"] || l2 === ability_dict["emhyr_whiteflame"]) {
			p1.disableLeader();
			p2.disableLeader();
			special_abilities["emhyr_whiteflame"] = true;
		} else {
			initLeader(p1, l1);
			initLeader(p2, l2);
			if (l1 === ability_dict["meve_white_queen"] || l2 === ability_dict["meve_white_queen"])
				special_abilities["meve_white_queen"] = true;
		}
		if (p1.deck.faction === p2.deck.faction && p1.deck.faction === "scoiatael")
			return;
		initFaction(p1);
		initFaction(p2);

		function initLeader(player, leader) {
			if (leader.placed)
				leader.placed(player.leader);
			Object.keys(leader).filter(key => game[key]).map(key => game[key].push(leader[key]));
		}

		function initFaction(player) {
			//Only passive faction abilities
			if (factions[player.deck.faction] && factions[player.deck.faction].factionAbility && !factions[player.deck.faction].activeAbility)
				factions[player.deck.faction].factionAbility(player);
		}
		
		return special_abilities;
	}

	// Sets initializes player abilities, player hands and redraw
	async startGame() {
		ui.toggleMusic_elem.classList.remove("music-customization");
		var special_abilities = this.initPlayers(player_me, player_op);
		await Promise.all([...Array(10).keys()].map(async () => {
			await player_me.deck.draw(player_me.hand);
			await player_op.deck.draw(player_op.hand);
		}));

		await this.runEffects(this.gameStart);
		if (!this.firstPlayer)
			this.firstPlayer = await this.coinToss();
		if (special_abilities["emhyr_whiteflame"]) await ui.notification("op-white-flame", 1200);
		if (special_abilities["meve_white_queen"]) await ui.notification("meve_white_queen", 1200);
		this.initialRedraw();
		somCarta();
	}

	// Simulated coin toss to determine who starts game
	async coinToss() {
		this.firstPlayer = (Math.random() < 0.5) ? player_me : player_op;
		await ui.notification(this.firstPlayer.tag + "-coin", 1200);
		return this.firstPlayer;
	}

	// Allows the player to swap out up to two cards from their iniitial hand
	async initialRedraw() {
		for (let i = 0; i < 2; i++)
			player_op.controller.redraw();
		await ui.queueCarousel(player_me.hand, 2, async (c, i) => await player_me.deck.swap(c, c.removeCard(i)), c => true, true, true, "Choose up to 2 cards to redraw.");
		ui.enablePlayer(false);
		game.startRound();
	}

	// Initiates a new round of the game
	async startRound(verdict=false) {
		this.roundCount++;
		if (verdict) {
			//Last round winner starts the round
			this.currPlayer = verdict.winner.opponent();
		} else {
			this.currPlayer = (this.roundCount % 2 === 0) ? this.firstPlayer : this.firstPlayer.opponent();
		}
		player_me.roundStartReset();
		player_op.roundStartReset();

		await this.runEffects(this.roundStart);

		if (!player_me.canPlay())
			player_me.setPassed(true);
		if (!player_op.canPlay())
			player_op.setPassed(true);

		if (player_op.passed && player_me.passed)
			return this.endRound();

		if (this.currPlayer.passed)
			this.currPlayer = this.currPlayer.opponent();

		await ui.notification("round-start", 1200);
		if (this.currPlayer.opponent().passed)
			await ui.notification(this.currPlayer.tag + "-turn", 1200);

		this.startTurn();
	}

	// Starts a new turn. Enables client interraction in client's turn.
	async startTurn() {
		await this.runEffects(this.turnStart);
		if (!this.currPlayer.opponent().passed) {
			this.currPlayer = this.currPlayer.opponent();
			await ui.notification(this.currPlayer.tag + "-turn", 1200);
		}
		ui.enablePlayer(this.currPlayer === player_me);
		this.currPlayer.startTurn();
	}

	// Ends the current turn and may end round. Disables client interraction in client's turn.
	async endTurn() {
		if (this.currPlayer === player_me)
			ui.enablePlayer(false);
		await this.runEffects(this.turnEnd);
		if (this.currPlayer.passed)
			await ui.notification(this.currPlayer.tag + "-pass", 1200);
		board.updateScores();
		if (player_op.passed && player_me.passed)
			this.endRound();
		else
			this.startTurn();
	}

	// Ends the round and may end the game. Determines final scores and the round winner.
	async endRound() {
		limpar();
		let dif = player_me.total - player_op.total;
		if (dif === 0) {
			let nilf_me = player_me.deck.faction === "nilfgaard",
				nilf_op = player_op.deck.faction === "nilfgaard";
			dif = nilf_me ^ nilf_op ? nilf_me ? 1 : -1 : 0;
		}
		let winner = dif > 0 ? player_me : dif < 0 ? player_op : null;
		let verdict = {
			winner: winner,
			score_me: player_me.total,
			score_op: player_op.total
		}
		this.roundHistory.push(verdict);

		await this.runEffects(this.roundEnd);

		board.row.forEach(row => row.clear());
		weather.clearWeather();

		player_me.endRound(dif > 0);
		player_op.endRound(dif < 0);

		if (dif > 0) {
			await ui.notification("win-round", 1200);
		} else if (dif < 0) {
			if (nilfgaard_wins_draws) {
				nilfgaard_wins_draws = false;
				await ui.notification("nilfgaard-wins-draws", 1200);
			}
			await ui.notification("lose-round", 1200);
		} else
			await ui.notification("draw-round", 1200);

		if (player_me.health === 0 || player_op.health === 0)
			this.endGame();
		else
			this.startRound(verdict);
	}

	// Sets up and displays the end-game screen
	async endGame() {
		called_leader = false;
		let endScreen = document.getElementById("end-screen");
		let rows = endScreen.getElementsByTagName("tr");
		rows[1].children[0].innerHTML = player_me.name;
		rows[2].children[0].innerHTML = player_op.name;

		for (let i = 1; i < 4; ++i) {
			let round = this.roundHistory[i - 1];
			rows[1].children[i].innerHTML = round ? round.score_me : 0;
			rows[1].children[i].style.color = round && round.winner === player_me ? "goldenrod" : "";

			rows[2].children[i].innerHTML = round ? round.score_op : 0;
			rows[2].children[i].style.color = round && round.winner === player_op ? "goldenrod" : "";
		}

		endScreen.children[0].className = "";
		if (player_op.health <= 0 && player_me.health <= 0) {
			tocar("");
			endScreen.getElementsByTagName("p")[0].classList.remove("hide");
			endScreen.children[0].classList.add("end-draw");
		} else if (player_op.health === 0) {
			tocar("game_win", true);
			endScreen.children[0].classList.add("end-win");
		} else {
			tocar("game_lose", true);
			endScreen.children[0].classList.add("end-lose");
		}

		fadeIn(endScreen, 300);
		ui.enablePlayer(true);
	}

	// Returns the client to the deck customization screen
	returnToCustomization() {
		iniciarMusica();
		this.reset();
		player_me.reset();
		player_op.reset();
		ui.toggleMusic_elem.classList.add("music-customization");
		this.endScreen.classList.add("hide");
		document.getElementById("deck-customization").classList.remove("hide");
	}

	// Restarts the last game with the same decks
	restartGame() {
		iniciarMusica();
		limpar();
		this.reset();
		player_me.reset();
		player_op.reset();
		this.endScreen.classList.add("hide");
		this.startGame();
	}

	// Executes effects in list. If effect returns true, effect is removed.
	async runEffects(effects) {
		for (let i = effects.length - 1; i >= 0; --i) {
			let effect = effects[i];
			if (await effect())
				effects.splice(i, 1)
		}
	}

}

// Contians information and behavior of a Card
class Card {

	constructor(key, card_data, player) {
		if (!card_data) {
			console.log("Invalid card data for: "+key);
		}
		this.id;
		if (card_data.id)
			this.id = Number(card_data.id);
		this.key = key;
		this.name = card_data.name;
		this.basePower = this.power = Number(card_data.strength);
		this.faction = card_data.deck;
		// To clean the field in case it is a faction specific weather/special card
		if (this.faction.startsWith("weather") || this.faction.startsWith("special")) {
			this.faction = this.faction.split(" ")[0];
        }
		this.abilities = (card_data.ability === "") ? [] : card_data.ability.split(" ");
		this.row = (this.faction === "weather") ? this.faction : card_data.row;
		this.filename = card_data.filename;
		this.placed = [];
		this.removed = [];
		this.activated = [];
		this.holder = player;
		this.locked = false;
		this.decoyTarget = false;
		this.target = "";
		this.currentLocation = board;	// By default, updated later
		if ("target" in card_data) {
			this.target = card_data.target;
		}
		this.quote = "";
		if ("quote" in card_data) {
			this.quote = card_data.quote;
		}

		this.hero = false;
		if (this.abilities.length > 0) {
			if (this.abilities[0] === "hero") {
				this.hero = true;
				this.abilities.splice(0, 1);
			}
			for (let x of this.abilities) {
				let ab = ability_dict[x];
				if ("placed" in ab) this.placed.push(ab.placed);
				if ("removed" in ab) this.removed.push(ab.removed);
				if ("activated" in ab) this.activated.push(ab.activated);
			}
		}
		if (this.row === "leader")
			this.desc_name = "Leader Ability";
		else if (this.abilities.length > 0) {
			this.desc_name = ability_dict[this.abilities[this.abilities.length - 1]].name;
			if (this.abilities.length > 1)
				this.desc_name += " / " + ability_dict[this.abilities[this.abilities.length - 2]].name;
		} else if (this.row === "agile")
			this.desc_name = "Agile";
		else if (this.hero)
			this.desc_name = "Hero";
		else
			this.desc_name = "";

		this.desc = this.row === "agile" ? "<p><b>Agile:</b> " + ability_dict["agile"].description + "</p>" : "";
		for (let i = this.abilities.length - 1; i >= 0; --i) {
			let abi_name = (ability_dict[this.abilities[i]].name ? ability_dict[this.abilities[i]].name : "Leader Ability");
			this.desc += "<p><b>" + abi_name + ":</b> " + ability_dict[this.abilities[i]].description + "</p>";
		}
		// If Summon Avenger card, give information about the card being summoned
		if (this.abilities.includes("avenger") && this.target) {
			let target = card_dict[this.target];
			this.desc += "<p>Summons <b>" + target["name"] + "</b> with strength " + target["strength"];
			if (target["ability"].length > 0)
				this.desc += " and abilities " + target["ability"].split(" ").map(a => ability_dict[a]["name"]).join(" / ");
			this.desc += "</p>";
        }
		if (this.hero)
			this.desc += "<p><b>Hero:</b> " + ability_dict["hero"].description + "</p>";

		this.elem = this.createCardElem(this);
	}

	// Returns the identifier for this type of card
	getId() {
		return this.key;
	}

	// Sets and displays the current power of this card
	setPower(n) {
		if (this.key === "spe_decoy")
			return;
		let elem = this.elem.children[0].children[0];
		if (n !== this.power) {
			this.power = n;
			elem.innerHTML = this.power;
		}
		elem.style.color = (n > this.basePower) ? "goldenrod" : (n < this.basePower) ? "red" : "";
	}

	// Resets the power of this card to default
	resetPower() {
		this.setPower(this.basePower);
	}

	// Automatically sends and translates this card to its apropriate row from the passed source
	async autoplay(source) {
		await board.toRow(this, source);
	}

	// Animates an ability effect
	async animate(name, bFade = true, bExpand = true) {
		if (!may_pass1 && playingOnline) await sleep(600);
		var guia = {
			"medic" : "med",
			"muster" : "ally",
			"morale" : "moral",
			"bond" : "moral"
		}
		var temSom = new Array();
		for (var x in guia) temSom[temSom.length] = x;
		var literais = ["scorch", "spy", "horn", "shield", "lock", "seize", "knockback", "resilience"];
		var som = literais.indexOf(name) > -1 ? literais[literais.indexOf(name)] : temSom.indexOf(name) > -1 ? guia[name] : "";
		if (som != "") tocar(som, false);
		if (name === "scorch") {
			return await this.scorch(name);
		}
		let anim = this.elem.children[this.elem.children.length - 1];
		anim.style.backgroundImage = iconURL("anim_" + name);
		await sleep(50);

		if (bFade) fadeIn(anim, 300);
		if (bExpand) anim.style.backgroundSize = "100% auto";
		await sleep(300);

		if (bExpand) anim.style.backgroundSize = "80% auto";
		await sleep(1000);

		if (bFade) fadeOut(anim, 300);
		if (bExpand) anim.style.backgroundSize = "40% auto";
		await sleep(300);

		anim.style.backgroundImage = "";
	}

	// Animates the scorch effect
	async scorch(name) {
		let anim = this.elem.children[this.elem.children.length-1];
		anim.style.backgroundSize = "cover";
		anim.style.backgroundImage = iconURL("anim_" + name);
		await sleep(50);

		fadeIn(anim, 300);
		await sleep(1300);

		fadeOut(anim, 300);
		await sleep(300);

		anim.style.backgroundSize = "";
		anim.style.backgroundImage = "";
	}

	// Returns true if this is a combat card that is not a Hero
	isUnit() {
		return !this.hero && (this.row === "close" || this.row === "ranged" || this.row === "siege" || this.row === "agile");
	}

	// Returns true if card is sent to a Row's special slot
	isSpecial() {
		return ["spe_horn", "spe_mardroeme", "spe_sign_quen", "spe_sign_yrden", "spe_toussaint_wine", "lr_lyria_rivia_morale", "spe_wyvern_shield", "spe_mantlet", "spe_garrison", "spe_dimeritium_shackles"].includes(this.key);
	}

	// Compares by type then power then name
	static compare(a, b) {
		var dif = factionRank(a) - factionRank(b);
		if (dif !== 0)
			return dif;
		// Muster/Bond cards
		if (a.target && b.target && a.target === b.target) {
			if (a.id && b.id)
				return Number(a.id) - Number(b.id);
			if (a.key && b.key)
				return a.key.localeCompare(b.key);
        }
		dif = a.basePower - b.basePower;
		if (dif && dif !== 0)
			return dif;
		
		return a.name.localeCompare(b.name);

		function factionRank(c) {
			return c.faction === "special" ? -2 : (c.faction === "weather") ? -1 : 0;
		}
	}

	// Creates an HTML element based on the card's properties
	createCardElem(card) {
		let elem = document.createElement("div");
		elem.style.backgroundImage = smallURL(card.faction + "_" + card.filename);
		elem.classList.add("card");
		elem.addEventListener("click", () => ui.selectCard(card), false);

		if (card.row === "leader")
			return elem;

		let power = document.createElement("div");
		elem.appendChild(power);
		let bg;
		if (card.hero) {
			bg = "power_hero";
			elem.classList.add("hero");
		} else if (card.faction === "weather") {
			bg = "power_" + card.abilities[0];
		} else if (card.faction === "special") {
			let str = card.abilities[0];
			if (str === "shield_c" || str === "shield_r" || str === "shield_s")
				str = "shield";
			bg = "power_" + str;
			elem.classList.add("special");
		} else {
			bg = "power_normal";
		}
		power.style.backgroundImage = iconURL(bg);

		let row = document.createElement("div");
		elem.appendChild(row);
		if (card.row === "close" || card.row === "ranged" || card.row === "siege" || card.row === "agile") {
			let num = document.createElement("div");
			num.appendChild(document.createTextNode(card.basePower));
			num.classList.add("center");
			power.appendChild(num);
			row.style.backgroundImage = iconURL("card_row_" + card.row);
		}

		let abi = document.createElement("div");
		elem.appendChild(abi);
		if (card.faction !== "special" && card.faction !== "weather" && card.abilities.length > 0) {
			let str = card.abilities[card.abilities.length - 1];
			if (str === "cerys")
				str = "muster";
			if (str.startsWith("avenger"))
				str = "avenger";
			if (str === "scorch_c" || str == "scorch_r" || str === "scorch_s")
				str = "scorch_combat";
			if (str === "shield_c" || str == "shield_r" || str === "shield_s")
				str = "shield";
			abi.style.backgroundImage = iconURL("card_ability_" + str);
		} else if (card.row === "agile")
			abi.style.backgroundImage = iconURL("card_ability_" + "agile");

		// For cards with 2 abilities
		if (card.abilities.length > 1) {
			let abi2 = document.createElement("div");
			abi2.classList.add("card-ability-2");
			elem.appendChild(abi2);
			let str = card.abilities[card.abilities.length - 2];
			if (str === "cerys")
				str = "muster";
			if (str.startsWith("avenger"))
				str = "avenger";
			if (str === "scorch_c" || str == "scorch_r" || str === "scorch_s")
				str = "scorch_combat";
			if (str === "shield_c" || str == "shield_r" || str === "shield_s")
				str = "shield";
			abi2.style.backgroundImage = iconURL("card_ability_" + str);
        }

		elem.appendChild(document.createElement("div")); // animation overlay
		return elem;
	}

	// Indicates whether or not the abilities of this card are locked
	isLocked() {
		return this.locked;
    }
}

function passBreak() {
	clearInterval(timer2);
	load_pass = load_passT;
	may_pass2 = "";
	document.getElementById("pass-button").innerHTML = original;
}

function passStart(input) {
	if (may_pass1 && may_pass2 == "") {
		may_pass2 = input;
		ui.passLoad();
		timer2 = setInterval(function () {
			ui.passLoad();
		}, 750);
	}
}

var original = "Pass";
var fileira_clicavel = null;
const load_passT = 3;
var cache_notif = ["op-leader"];
var load_pass = load_passT,
	may_pass1 = false,
	may_pass2 = "",
	may_pass3 = true,
	fimU = false,
	carta_c = false,
	hover_row = true,
	timer2, lCard;

// Handles notifications and client interration with menus
class UI {
	constructor() {
		this.carousels = [];
		this.notif_elem = document.getElementById("notification-bar");
		this.preview = document.getElementsByClassName("card-preview")[0];
		this.previewCard = null;
		this.lastRow = null;
        if (!isMobile()) {
			document.getElementById("pass-button").addEventListener("mousedown", function(e) {
				if (e.button == 0) {
					passStart("mouse");
					may_pass3 = false;
				} else if (may_pass2 == "mouse") passBreak();
			});
			document.getElementById("pass-button").addEventListener("mouseup", () => {
				if (may_pass2 == "mouse") passBreak();
			}, false);
			document.getElementById("pass-button").addEventListener("mouseout", () => {
				if (may_pass2 == "mouse") passBreak();
			}, false);
			window.addEventListener("keydown", function (e) {
				switch (e.keyCode) {
					case 81:
						e.preventDefault();
						try {
							ui.cancel();
						} catch (err) {}
						break;
					case 32:
						if (may_pass3) passStart("keyboard");
						break;
				}
			});
			window.addEventListener("keyup", function (e) {
				if (e.keyCode == 32 && may_pass1) {
					may_pass3 = true;
					if (may_pass2 == "keyboard") passBreak();
				}
			});
		} else document.getElementById("pass-button").addEventListener("click", function(e) {
			player_me.passRound();
		});
		document.getElementById("click-background").addEventListener("click", () => ui.cancel(), false);
		this.youtube;
		this.ytActive;
		this.toggleMusic_elem = document.getElementById("toggle-music");
		this.toggleMusic_elem.classList.add("fade");
		this.toggleMusic_elem.addEventListener("click", () => this.toggleMusic(), false);
	}

	passLoad() {
		load_pass--;
		if (load_pass == -1) {
			document.getElementById("pass-button").innerHTML = original;
			load_pass = load_passT;
			player_me.passRound();
			passBreak();
		} else document.getElementById("pass-button").innerHTML = load_pass + 1;
	}

	// Enables or disables client interration
	enablePlayer(enable) {
		let main = document.getElementsByTagName("main")[0].classList;
		if (enable) main.remove("noclick");
		else main.add("noclick");
	}

	// Initializes the youtube background music object
	initYouTube() {
		this.youtube = new YT.Player('youtube', {
			videoId: "UE9fPWy1_o4",
			playerVars: {
				"autoplay": 1,
				"controls": 0,
				"loop": 1,
				"playlist": "UE9fPWy1_o4",
				"rel": 0,
				"version": 3,
				"modestbranding": 1
			},
			events: {
				'onStateChange': initButton
			}
		});

		function initButton() {
			if (ui.ytActive !== undefined)
				return;
			ui.ytActive = true;
			ui.youtube.playVideo();
			let timer = setInterval(() => {
				if (ui.youtube.getPlayerState() !== YT.PlayerState.PLAYING)
					ui.youtube.playVideo();
				else {
					clearInterval(timer);
					ui.toggleMusic_elem.classList.remove("fade");
				}
			}, 500);
		}
	}

	// Called when client toggles the music
	toggleMusic() {
		if (this.youtube.getPlayerState() !== YT.PlayerState.PLAYING) iniciarMusica();
		else {
			this.youtube.pauseVideo();
			this.toggleMusic_elem.classList.add("fade");
		}
	}

	// Enables or disables backgorund music 
	setYouTubeEnabled(enable) {
		if (this.ytActive === enable)
			return;
		if (enable && !this.mute)
			ui.youtube.playVideo();
		else
			ui.youtube.pauseVideo();
		this.ytActive = enable;
	}

	// Called when the player selects a selectable card
	async selectCard(card) {
		let row = this.lastRow;
		let pCard = this.previewCard;
		if (card === pCard)
			return;
		if (pCard === null || card.holder.hand.cards.includes(card)) {
			this.setSelectable(null, false);
			this.showPreview(card);
		} else if (pCard.abilities.includes("decoy")) {
			this.hidePreview(card);
			this.enablePlayer(false);
			card.decoyTarget = true;
			board.toHand(card, row);
			await board.moveTo(pCard, row, pCard.holder.hand);
			pCard.holder.endTurn();
		} else if (pCard.abilities.includes("alzur_maker")) {
			this.hidePreview(card);
			this.enablePlayer(false);
			await board.toGrave(card, row);
			let target = new Card(ability_dict["alzur_maker"].target, card_dict[ability_dict["alzur_maker"].target], card.holder);
			//target.removed.push(() => setTimeout(() => target.holder.grave.removeCard(target), 1001));
			await board.addCardToRow(target, target.row, card.holder);
			pCard.holder.endTurn();
		}
	}

	// Called when the player selects a selectable CardContainer
	async selectRow(row,isSpecial=false) {
		this.lastRow = row;
        if (this.previewCard === null) {
            if (isSpecial)
                await ui.viewCardsInContainer(row.special);
            else
			    await ui.viewCardsInContainer(row);
			return;
		}
		if (this.previewCard.key === "spe_decoy" || this.previewCard.abilities.includes("alzur_maker"))
			return;
		if (this.previewCard.abilities.includes("decoy") && row.cards.filter(c => c.isUnit()).length > 0)
			return;	// If a unit can be selected, we cannot select the whole row
		let card = this.previewCard;
		let holder = card.holder;
		this.hidePreview();
		this.enablePlayer(false);
		if (card.faction === "special" && card.abilities.includes("scorch")) {
			this.hidePreview();
			if (!game.scorchCancelled)
				await ability_dict["scorch"].activated(card);
		} else if (card.faction === "special" && card.abilities.includes("cintra_slaughter")) {
			this.hidePreview();
			await ability_dict["cintra_slaughter"].activated(card);
		} else if (card.faction === "special" && card.abilities.includes("seize")) {
			this.hidePreview();
			await ability_dict[card.abilities.at(-1)].activated(card);
		} else if (card.faction === "special" && card.abilities.includes("knockback")) {
			this.hidePreview();
			await ability_dict[card.abilities.at(-1)].activated(card, row);
		} else if (card.key === "spe_decoy" || card.abilities.includes("alzur_maker")) {
			return;
		} else if (card.abilities.includes("decoy") && row.cards.filter(c => c.isUnit()).length > 0) {
			return;	// If a unit can be selected, we cannot select the whole row
		} else if (card.abilities.includes("anna_henrietta_duchess")) {
			this.hidePreview(card);
			this.enablePlayer(false);
			let horn = row.special.cards.filter(c => c.abilities.includes("horn"))[0];
			if (horn)
				await board.toGrave(horn, row);
		} else if (card.key === "lr_lyria_rivia_morale") {
			await board.moveTo(card, row);
		} else if (card.abilities.includes("meve_princess") || card.abilities.includes("carlo_varese")) {
			this.hidePreview(card);
			this.enablePlayer(false);
			if (!game.scorchCancelled)
				await row.scorch();
		} else if (card.abilities.includes("cyrus_hemmelfart")) {
			this.hidePreview(card);
			this.enablePlayer(false);
			let new_card = new Card("spe_dimeritium_shackles", card_dict["spe_dimeritium_shackles"], card.holder);
			await board.moveTo(new_card, row);
		} else if (card.faction === "special" && card.abilities.includes("bank")) {
			this.hidePreview();
			await ability_dict["bank"].activated(card);
		} else {
			await board.moveTo(card, row, card.holder.hand);
		}
		holder.endTurn();
	}

	// Called when the client cancels out of a card-preview
	cancel() {
		if (!fimU) {
			fimU = true;
			tocar("discard", false);
			lCard = null;
			exibindo_lider = false;
			carta_c = false;
			this.hidePreview();
		}
	}

	// Displays a card preview then enables and highlights potential card destinations
	showPreview(card) {
		fimU = false;
		tocar("explaining", false);
		this.showPreviewVisuals(card);
		this.setSelectable(card, true);
		document.getElementById("click-background").classList.remove("noclick");
	}

	// Sets up the graphics and description for a card preview
	showPreviewVisuals(card) {
		this.previewCard = card;
		this.preview.classList.remove("hide");
		getPreviewElem(this.preview.getElementsByClassName("card-lg")[0],card)
		this.preview.getElementsByClassName("card-lg")[0].addEventListener("mousedown", function() {
			if (fileira_clicavel !== null && may_act_card) {
				ui.selectRow(fileira_clicavel);
				may_act_card = false;
				fileira_clicavel = null;
			}
		});
		this.preview.getElementsByClassName("card-lg")[0].addEventListener("mouseup", function() {
			may_act_card = true;
		});
		let desc_elem = this.preview.getElementsByClassName("card-description")[0];
		this.setDescription(card, desc_elem);
	}

	// Hides the card preview then disables and removes highlighting from card destinations
	hidePreview() {
		document.getElementById("click-background").classList.add("noclick");
		player_me.hand.cards.forEach(c => c.elem.classList.remove("noclick"));

		this.preview.classList.add("hide");
		this.setSelectable(null, false);
		this.previewCard = null;
		this.lastRow = null;
	}

	// Sets up description window for a card
	setDescription(card, desc) {
		if (card.hero || card.row === "agile" || card.abilities.length > 0 || card.faction === "faction") {
			desc.classList.remove("hide");
			let str = card.row === "agile" ? "agile" : "";
			if (card.abilities.length)
				str = card.abilities[card.abilities.length - 1];
			if (str === "cerys")
				str = "muster";
			if (str.startsWith("avenger"))
				str = "avenger";
			if (str === "scorch_c" || str == "scorch_r" || str === "scorch_s")
				str = "scorch_combat";
			if (str === "shield_c" || str == "shield_r" || str === "shield_s")
				str = "shield";
			
			if (card.faction === "faction" || card.abilities.length === 0 && card.row !== "agile")
				desc.children[0].style.backgroundImage = "";
			else if (card.row === "leader")
				desc.children[0].style.backgroundImage = iconURL("deck_shield_" + card.faction);
			else
				desc.children[0].style.backgroundImage = iconURL("card_ability_" + str);
			desc.children[1].innerHTML = card.desc_name;
			desc.children[2].innerHTML = card.desc;
		} else {
			desc.classList.add("hide");
		}
	}

	// Displayed a timed notification to the client
	async notification(name, duration) {
		var guia1 = {
			"notif-nilfgaard-wins-draws": "Nilfgaard wins draws",
			"notif-op-white-flame": "The opponent's leader cancel your opponent's Leader Ability",
			"notif-op-leader": "Opponent uses leader",
			"notif-me-first": "You will go first",
			"notif-op-first": "Your opponent will go first",
			"notif-me-coin": "You will go first",
			"notif-op-coin": "Your opponent will go first",
			"notif-round-start": "Round Start",
			"notif-me-pass": "Round passed",
			"notif-op-pass": "Your opponent has passed",
			"notif-win-round": "You won the round!",
			"notif-lose-round": "Your opponent won the round",
			"notif-draw-round": "The round ended in a draw",
			"notif-me-turn": "Your turn!",
			"notif-op-turn": "Opponent's turn",
			"notif-north": "Northern Realms faction ability triggered - North draws an additional card.",
			"notif-monsters": "Monsters faction ability triggered - one randomly-chosen Monster Unit Card stays on the board",
			"notif-scoiatael": "Opponent used the Scoia'tael faction perk to go first.",
			"notif-skellige-op": "Opponent Skellige Ability Triggered!",
			"notif-skellige-me": "Skellige Ability Triggered!",
			"notif-witcher_universe": "Witcher Universe used its faction ability and skipped a turn",
			"notif-toussaint": "Toussaint faction ability triggered - Toussaint draws an additional card.",
			"notif-toussaint-decoy-cancelled": "Toussaint Leader ability used - Decoy ability cancelled for the rest of the round.",
			"notif-lyria_rivia": "Lyria & Rivia ability used - Morale Boost effect applied to a row.",
			"notif-meve_white_queen": "Lyria & Rivia leader allows both players to restore 2 units when using the medic ability.",
			"notif-north-scorch-cancelled": "Northern Realms Leader ability used - Scorch ability cancelled for the rest of the round.",
		}
		var guia2 = {
			"me-pass" : "pass",
			"win-round" : "round_win",
			"lose-round" : "round_lose",
			"me-turn" : "turn_me",
			"op-turn" : "turn_op",
			"op-leader" : "turn_op",
			"op-white-flame" : "turn_op",
			"nilfgaard-wins-draws" : "turn_op"
		}
		var temSom = new Array();
		for (var x in guia2) temSom[temSom.length] = x;
		var som = temSom.indexOf(name) > -1 ? guia2[name] : name == "round-start" && game.roundHistory.length == 0 ? "round1_start" : "";
		if (som != "") tocar(som, false);
		this.notif_elem.children[0].id = "notif-" + name;
		this.notif_elem.children[0].style.backgroundImage = name == "op-leader" ? "url(img/icons/notif_" + player_op.deck.faction + ".png)" : "";
		var caracteres = guia1[this.notif_elem.children[0].id].length;
		var palavras = guia1[this.notif_elem.children[0].id].split(" ").length;
		duration = parseInt(0.7454878 * Math.max(parseInt((1e3 / 17) * caracteres), parseInt((6e4 / 300) * palavras)) + 211.653152) + 1;
		const fadeSpeed = 150;
		fadeIn(this.notif_elem, fadeSpeed);
		var ch = playingOnline && duration < 1000 & cache_notif.indexOf(name) == -1 ? 800 : 0;
        cache_notif[cache_notif.length] = name;
        duration += ch;
        let d = new Date().getTime();
        fadeOut(this.notif_elem, fadeSpeed, duration - fadeSpeed - 50); // Removing some delay to avoid weird behaviours if the fadeOut starts late and has not ended when the next fadeIn starts
        await sleep(duration);
	}

	// Displays a cancellable Carousel for a single card 
	async viewCard(card, action) {
		if (card === null) return;
		if (lCard !== card.name) {
			lCard = card.name;
			let container = new CardContainer();
			container.cards.push(card);
			await this.viewCardsInContainer(container, action);
		}
	}

	// Displays a cancellable Carousel for all cards in a container
	async viewCardsInContainer(container, action) {
		action = action ? action : function () {
			return this.cancel();
		};
		await this.queueCarousel(container, 1, action, () => true, false, true);
	}

	// Displays a Carousel menu of filtered container items that match the predicate.
	// Suspends gameplay until the Carousel is closed. Automatically picks random card if activated for AI player
	async queueCarousel(container, count, action, predicate, bSort, bQuit, title) {
		if (game.currPlayer === player_op) {
			if (player_op.controller instanceof ControllerAI)
				for (let i = 0; i < count; ++i) {
					let cards = container.cards.reduce((a, c, i) => !predicate || predicate(c) ? a.concat([i]) : a, []);
					await action(container, cards[randomInt(cards.length)]);
				}
			return;
		}
		let carousel = new Carousel(container, count, action, predicate, bSort, bQuit, title);
		if (Carousel.curr === undefined || Carousel.curr === null) {
			carousel.start();
		}  else {
			this.carousels.push(carousel);
			return;
		}
		await sleepUntil(() => this.carousels.length === 0 && !Carousel.curr, 100);
	}

	// Starts the next queued Carousel
	quitCarousel() {
		if (this.carousels.length > 0) {
			this.carousels.shift().start();
		}
	}

	// Displays a custom confirmation menu 
	async popup(yesName, yes, noName, no, title, description) {
		let p = new Popup(yesName, yes, noName, no, title, description);
		await sleepUntil(() => !Popup.curr)
	}

	// Enables or disables selection and highlighting of rows specific to the card
    setSelectable(card, enable) {
		if (!enable) {
			for (let row of board.row) {
				row.elem.classList.remove("row-selectable");
				row.elem.classList.remove("noclick");
				row.special.elem.classList.remove("row-selectable");
				row.special.elem.classList.remove("noclick");
				alteraClicavel(row, false);

				for (let card of row.cards) {
					card.elem.classList.add("noclick");
				}
			}
			weather.elem.classList.remove("row-selectable");
			weather.elem.classList.remove("noclick");
			alteraClicavel(weather, false);
			return;
		}
		if (card.faction === "weather") {
			for (let row of board.row) {
				row.elem.classList.add("noclick");
				row.special.elem.classList.add("noclick");
			}
			weather.elem.classList.add("row-selectable");
			carta_c = true;
			document.getElementById("field-op").addEventListener("click",function() {
				cancelaClima();
			});
			document.getElementById("field-me").addEventListener("click",function() {
				cancelaClima();
			});
			alteraClicavel(weather, true);
			return;
		}

		weather.elem.classList.add("noclick");

		// Affects all board
		if (card.faction === "special" && card.abilities.includes("scorch")) {
			for (let r of board.row) {
				if (r.isShielded() || game.scorchCancelled) {
					r.elem.classList.add("noclick");
					r.special.elem.classList.add("noclick");
				} else {
					r.elem.classList.add("row-selectable");
					r.special.elem.classList.add("row-selectable");
					alteraClicavel(r, true);
                }
			}
			return;
		}
		// Affects only own side of board
		if (card.faction === "special" && (card.abilities.includes("cintra_slaughter") || card.abilities.includes("bank"))) {
			for (let i = 0; i < 6; i++) {
				let r = board.row[i];
				if (i > 2) {
					r.elem.classList.add("row-selectable");
					r.special.elem.classList.add("row-selectable");
					alteraClicavel(r, true);
                }
			}
			return;
		}
		// Affects enemy side of the board
		// Affects only opponent melee and ranged row
		if (card.faction === "special" && card.abilities.includes("knockback")) {
			for (var i = 1; i < 3; i++) {
				let r = board.row[i];
				if (!r.isShielded()) {
					r.elem.classList.add("row-selectable");
					r.special.elem.classList.add("row-selectable");
					alteraClicavel(r, true);
				}
            }
			return;
		}
		// Affects only opponent melee row
		if (card.faction === "special" && card.abilities.includes("seize")) {
			let r = board.row[2];
			if (!r.isShielded()) {
				r.elem.classList.add("row-selectable");
				r.special.elem.classList.add("row-selectable");
				alteraClicavel(r, true);
            }
			return;
		}
		//Affects only own rows that are available
		if (card.isSpecial()) {
			for (let i = 0; i < 6; i++) {
				let r = board.row[i];
				//Affects OP side
				if (card.abilities.includes("lock")) {
					if (i > 2 || r.special.containsCardByKey(card.key) || r.isShielded()) {
						r.elem.classList.add("noclick");
						r.special.elem.classList.add("noclick");
					} else {
						r.special.elem.classList.add("row-selectable");
						fileira_clicavel = null;
					}
				} else if (card.abilities.includes("shield_c") || card.abilities.includes("shield_r") || card.abilities.includes("shield_s")) {
					if ((card.abilities.includes("shield_c") && i == 3) || (card.abilities.includes("shield_r") && i == 4) || (card.abilities.includes("shield_s") && i == 5)) {
						r.special.elem.classList.add("row-selectable");
						fileira_clicavel = null;
					} else {
						r.elem.classList.add("noclick");
						r.special.elem.classList.add("noclick");
                    }
				} else {
					// Affects own side - Toussaint Wine does not affect siege row
					if (i < 3 || r.special.containsCardByKey(card.key) || (card.abilities.includes("toussaint_wine") && i == 5)) {
						r.elem.classList.add("noclick");
						r.special.elem.classList.add("noclick");
					} else {
						r.special.elem.classList.add("row-selectable");
						fileira_clicavel = null;
					}
                }
				
			}
			return;
		}

        if (card.abilities.includes("decoy") || card.abilities.includes("alzur_maker")) {
			for (let i = 0; i < 6; ++i) {
				let r = board.row[i];
				let units = r.cards.filter(c => c.isUnit());
				if (i < 3 || (card.key === "spe_decoy" && units.length === 0) || (card.abilities.includes("decoy") && game.decoyCancelled) ) {
					r.elem.classList.add("noclick");
					r.special.elem.classList.add("noclick");
					r.elem.classList.remove("card-selectable");
				} else {
					// For unit cards with Decoy ability, filter by the appropriate row
					if (card.abilities.includes("decoy") && card.row.length > 0) {
						if ((card.row === "close" && i === 3) || (card.row === "ranged" && i === 4) || (card.row === "siege" && i === 5) || (card.row === "agile" && i > 2 && i < 5)) {
							r.elem.classList.add("row-selectable");
							// Row is selectable if it contains no unit to select, in order to play the unit itself without its effect
							if (units.length === 0)
								r.elem.classList.remove("noclick");
							alteraClicavel(r, true);
							units.forEach(c => c.elem.classList.remove("noclick"));
						} else {
							r.elem.classList.add("noclick");
							r.special.elem.classList.add("noclick");
							r.elem.classList.remove("card-selectable");
                        }
					} else {
						r.elem.classList.add("row-selectable");
						alteraClicavel(r, true);
						units.forEach(c => c.elem.classList.remove("noclick"));
                    }
					
				}
			}
			return;
		}

		if (card.abilities.includes("anna_henrietta_duchess")) {
			for (let i = 0; i < 3; ++i) {
				let r = board.row[i];
				if (r.effects.horn > 0) {
					r.elem.classList.add("row-selectable");
					alteraClicavel(r, true);
				} else {
					r.elem.classList.add("noclick");
					r.special.elem.classList.add("noclick");
					r.elem.classList.remove("card-selectable");
				}
			}
			return;
		}

		// Target only enemy rows
		if (card.abilities.includes("meve_princess") || card.abilities.includes("carlo_varese")) {
			for (let i = 0; i < 3; ++i) {
				let r = board.row[i];
				if (r.isShielded() || !r.canBeScorched()) {
					r.elem.classList.add("noclick");
					r.special.elem.classList.add("noclick");
					r.elem.classList.remove("card-selectable");
				} else {
					r.elem.classList.add("row-selectable");
					alteraClicavel(r, true);
				}
			}
			return;
		}

		// Play special card on any opponent row, provided it doesn't already have one
		if (card.abilities.includes("cyrus_hemmelfart")) {
			for (let i = 0; i < 3; ++i) {
				let r = board.row[i];
				if (r.containsCardByKey("spe_dimeritium_shackles") || r.isShielded()) {
					r.elem.classList.add("noclick");
					r.special.elem.classList.add("noclick");
					r.elem.classList.remove("card-selectable");
				} else {
					r.elem.classList.add("row-selectable");
					alteraClicavel(r, true);
				}
			}
			return;
		}

		let currRows = card.row === "agile" ? [board.getRow(card, "close", card.holder), board.getRow(card, "ranged", card.holder)] : [board.getRow(card, card.row, card.holder)];
		for (let i = 0; i < 6; i++) {
			let row = board.row[i];
			if (currRows.includes(row)) {
				row.elem.classList.add("row-selectable");
				if (card.row !== "agile") alteraClicavel(row, true);
				else fileira_clicavel = null;
			} else {
				row.elem.classList.add("noclick");
			}
		}

	}
}

var fimC = false;

// Displays up to 5 cards for the client to cycle through and select to perform an action
// Clicking the middle card performs the action on that card "count" times
// Clicking adejacent cards shifts the menu to focus on that card
class Carousel {
	constructor(container, count, action, predicate, bSort, bExit = false, title) {
		if (count <= 0 || !container || !action || container.cards.length === 0)
			return;
		this.container = container;
		this.count = count;
		this.action = action ? action : () => this.cancel();
		this.predicate = predicate;
		this.bSort = bSort;
		this.indices = [];
		this.index = 0;
		this.bExit = bExit;
		this.title = title;
		this.cancelled = false;
		this.selection = [];

		if (!Carousel.elem) {
			Carousel.elem = document.getElementById("carousel");
			Carousel.elem.children[0].addEventListener("click", () => Carousel.curr.cancel(), false);
			window.addEventListener("keydown", function (e) {
				if (e.keyCode == 81) {
					e.preventDefault();
					try {
						Carousel.curr.cancel();
					} catch (err) {}
				}
			});
		}
		this.elem = Carousel.elem;
		document.getElementsByTagName("main")[0].classList.remove("noclick");

		this.elem.children[0].classList.remove("noclick");
		this.previews = this.elem.getElementsByClassName("card-lg");
		this.desc = this.elem.getElementsByClassName("card-description")[0];
		this.title_elem = this.elem.children[2];
	}

	// Initializes the current Carousel
	start() {
		if (!this.elem)
			return;
		this.indices = this.container.cards.reduce((a, c, i) => (!this.predicate || this.predicate(c)) ? a.concat([i]) : a, []);
		
		if (this.indices.length <= 0)
			return this.exit();
		if (this.bSort)
			this.indices.sort((a, b) => Card.compare(this.container.cards[a], this.container.cards[b]));

		this.update();
		Carousel.setCurrent(this);

		if (this.title) {
			this.title_elem.innerHTML = this.title;
			this.title_elem.classList.remove("hide");
		} else {
			this.title_elem.classList.add("hide");
		}

		this.elem.classList.remove("hide");
		ui.enablePlayer(true);
		tocar("explaining", false);
		fimC = false;
		setTimeout(function() {
			var label = document.getElementById("carousel_label");
			if (label.innerText.indexOf("redraw") > -1 && label.className.indexOf("hide") == -1) tocar("game_start", false);
		}, 50);
	}

	// Called by the client to cycle cards displayed by n
	shift(event, n) {
		try {
			(event || window.event).stopPropagation();
		} catch (err) {}
		tocar("card", false);
		this.index = Math.max(0, Math.min(this.indices.length - 1, this.index + n));
		this.update();
	}

	// Called by client to perform action on the middle card in focus
	async select(event) {
		try {
			(event || window.event).stopPropagation();
		} catch (err) { }
		// In case of multiple selections, we only do action if not already selected
		if (this.selection.indexOf(this.indices[this.index]) < 0) {
			var label = document.getElementById("carousel_label");
			if (label.innerText.indexOf("redraw") > -1 && label.className.indexOf("hide") == -1) {
				tocar("redraw", false);
			} else {
				this.selection.push(this.indices[this.index]);
            }
			--this.count;
			if (this.isLastSelection())
				this.elem.classList.add("hide");
			if (this.count <= 0)
				ui.enablePlayer(false);
			// For redraw, we run the action right away
			if (label.innerText.indexOf("redraw") > -1 && label.className.indexOf("hide") == -1)
				await this.action(this.container, this.indices[this.index]);
			if (this.isLastSelection() && !this.cancelled) {
				this.exit();
				this.selection.map(async s => await this.action(this.container, s));
				this.selection = [];
				return;
            }
				
		} else {
			// If already selected, remove from selection
			this.selection.splice(this.selection.indexOf(this.indices[this.index]), 1);
			this.count++;
        }
		this.update();
	}

	// Called by client to exit out of the current Carousel if allowed. Enables player interraction.
	cancel() {
		if (!fimC) {
			fimC = true;
			tocar("discard", false);
			lCard = null;
			exibindo_lider = false;
			if (this.bExit) {
				this.cancelled = true;
				this.exit();
			}
			ui.enablePlayer(true);
		}
	}

	// Returns true if there are no more cards to view or select
	isLastSelection() {
		return this.count <= 0 || this.indices.length === 0;
	}

	// Updates the visuals of the current selection of cards
	update() {
		this.indices = this.container.cards.reduce((a, c, i) => (!this.predicate || this.predicate(c)) ? a.concat([i]) : a, []);
		if (this.index >= this.indices.length)
			this.index = this.indices.length - 1;
		for (let i = 0; i < this.previews.length; i++) {
			let curr = this.index - 2 + i;
			if (curr >= 0 && curr < this.indices.length) {
				let card = this.container.cards[this.indices[curr]];
				getPreviewElem(this.previews[i], card);
				this.previews[i].classList.remove("hide");
				this.previews[i].classList.remove("noclick");
				if (this.selection.indexOf(this.indices[curr]) >= 0)
					this.previews[i].classList.add("selection");
				else
					this.previews[i].classList.remove("selection");
			} else {
				this.previews[i].style.backgroundImage = "";
				this.previews[i].classList.add("hide");
				this.previews[i].classList.add("noclick");
				this.previews[i].classList.remove("selection");
			}
		}
		ui.setDescription(this.container.cards[this.indices[this.index]], this.desc);
	}

	// Clears and quits the current carousel
	exit() {
		for (let x of this.previews) {
			x.style.backgroundImage = "";
			x.classList.remove("selection");
		}
		this.elem.classList.add("hide");
		Carousel.clearCurrent();
		ui.quitCarousel();
	}

	// Statically sets the current carousel
	static setCurrent(curr) {
		this.curr = curr;
	}

	// Statically clears the current carousel
	static clearCurrent() {
		this.curr = null;
	}
}

// Custom confirmation windows
class Popup {
	constructor(yesName, yes, noName, no, header, description) {
		this.yes = yes ? yes : () => {};
		this.no = no ? no : () => {};

		this.elem = document.getElementById("popup");
		let main = this.elem.children[0];
		main.children[0].innerHTML = header ? header : "";
		main.children[1].innerHTML = description ? description : "";
		main.children[2].children[0].innerHTML = (yesName) ? yesName : "Yes";
		main.children[2].children[1].innerHTML = (noName) ? noName : "No";

		this.elem.classList.remove("hide");
		Popup.setCurrent(this);
		ui.enablePlayer(true);
	}

	// Sets this as the current popup window
	static setCurrent(curr) {
		this.curr = curr;
	}

	// Unsets this as the current popup window
	static clearCurrent() {
		this.curr = null;
	}

	// Called when client selects the positive aciton
	selectYes() {
		this.clear()
		this.yes();
		return true;
	}

	// Called when client selects the negative option
	selectNo() {
		this.clear();
		this.no();
		return false;
	}

	// Clears the popup and diables player interraction
	clear() {
		ui.enablePlayer(false);
		this.elem.classList.add("hide");
		Popup.clearCurrent();
	}
}

var carta_selecionada = null;

// Screen used to customize, import and export deck contents
class DeckMaker {
	constructor() {
		this.elem = document.getElementById("deck-customization");
		this.bank_elem = document.getElementById("card-bank");
		this.deck_elem = document.getElementById("card-deck");
		this.leader_elem = document.getElementById("card-leader");
		this.leader_elem.children[1].addEventListener("click", () => this.selectLeader(), false);
		this.leader_elem.children[1].addEventListener("mouseover", function() {
			tocar("card", false);
			this.style.boxShadow = "0 0 1.5vw #6d5210"
		});
		this.leader_elem.children[1].addEventListener("mouseout", function() {
			this.style.boxShadow = "0 0 0 #6d5210"
		});

		this.faction = "realms";
		this.setFaction(this.faction, true);

		let start_deck = JSON.parse(JSON.stringify(premade_deck[0]));
		start_deck.cards = start_deck.cards.map(c => ({
			index: c[0],
			count: c[1]
        }));
        this.me_deck_title = start_deck.title;
		this.setLeader(start_deck.leader);
		this.makeBank(this.faction, start_deck.cards);

		this.start_op_deck;
		this.me_deck_index = 0;
		this.op_deck_index = 0;

		this.change_elem = document.getElementById("change-faction");
		this.change_elem.addEventListener("click", () => this.selectFaction(), false);

		document.getElementById("select-deck").addEventListener("click", () => this.selectDeck(), false);
		document.getElementById("select-op-deck").addEventListener("click", () => this.selectOPDeck(), false);
		document.getElementById("download-deck").addEventListener("click", () => this.downloadDeck(), false);
		document.getElementById("add-file").addEventListener("change", () => this.uploadDeck(), false);
		document.getElementById("start-game").addEventListener("click", () => this.startNewGame(), false);
		window.addEventListener("keydown", function (e) {
			if (document.getElementById("deck-customization").className.indexOf("hide") == -1) {
				switch(e.keyCode) {
					case 69:
						try {
							Carousel.curr.cancel();
						} catch(err) {}
						if (isLoaded && iniciou) dm.startNewGame();
						break;
					case 88:
						dm.selectLeader();
						break;
				}
			}
		});
		somCarta();

		this.update();
	}

	// Called when client selects a deck faction. Clears previous cards and makes valid cards available.
	setFaction(faction_name, silent) {
		if (!silent && this.faction === faction_name)
			return false;
		if (!silent) {
			tocar("warning", false);
			if (!confirm("Changing factions will clear the current deck. Continue? ")) {
				tocar("warning", false);
				return false;
			}
		}
		this.elem.getElementsByTagName("h1")[0].innerHTML = factions[faction_name].name;
		this.elem.getElementsByTagName("h1")[0].style.backgroundImage = iconURL("deck_shield_" + faction_name);
		document.getElementById("faction-description").innerHTML = factions[faction_name].description;

		this.leaders =
			Object.keys(card_dict).map(cid => ({
				card: card_dict[cid],
				index: cid
			}))
			.filter(c => c.card.deck === faction_name && c.card.row === "leader");
		if (!this.leader || this.faction !== faction_name) {
			this.leader = this.leaders[0];
			getPreviewElem(this.leader_elem.children[1], this.leader.card)
		}
		this.faction = faction_name;
		setTimeout(function() {
			somCarta();
		}, 300);
		return true;
	}

	// Called when client selects a leader for their deck
	setLeader(index) {
		this.leader = this.leaders.filter(l => l.index == index)[0];
		getPreviewElem(this.leader_elem.children[1], this.leader.card)
	}

	// Constructs a bank of cards that can be used by the faction's deck.
	// If a deck is provided, will not add cards to bank that are already in the deck.
	makeBank(faction, deck) {
		this.clear();
		let cards = Object.keys(card_dict).map(cid => ({
			card: card_dict[cid],
			index: cid
		})).filter(
			p => ( ([faction, "neutral", "weather", "special"].includes(p.card.deck) ||
				(["weather", "special"].includes(p.card.deck.split(" ")[0]) && p.card.deck.split(" ").includes(faction)))
					&& p.card.row !== "leader"));

		cards.sort(function (id1, id2) {
			let a = card_dict[id1.index],
				b = card_dict[id2.index];
			let c1 = {
				name: a.name,
				basePower: -a.strength,
				faction: a.deck.split(" ")[0] // Cleaning for faction specific special/weather cards
			};
			let c2 = {
				name: b.name,
				basePower: -b.strength,
				faction: b.deck.split(" ")[0] // Cleaning for faction specific special/weather cards
			};
			return Card.compare(c1, c2);
		});


		let deckMap = {};
		if (deck) {
			for (let i of Object.keys(deck)) deckMap[deck[i].index] = deck[i].count;
		}
		cards.forEach(p => {
			let count = deckMap[p.index] !== undefined ? Number(deckMap[p.index]) : 0;
			this.makePreview(p.index, Number.parseInt(p.card.count) - count, this.bank_elem, this.bank, );
			this.makePreview(p.index, count, this.deck_elem, this.deck);
		});
	}

	// Creates HTML elements for the card previews
	makePreview(index, num, container_elem, cards) {
		let card_data = card_dict[index];

		let elem = document.createElement("div");
		elem.classList.add("card-lg");
		elem = getPreviewElem(elem, card_data, num);
		container_elem.appendChild(elem);

		let bankID = {
			index: index,
			count: num,
			elem: elem
		};
		let isBank = cards === this.bank;
		cards.push(bankID);
		let cardIndex = cards.length - 1;
		elem.addEventListener("dblclick", () => this.select(cardIndex, isBank), false);
		elem.addEventListener("mouseover", () => {
			var aux = this;
			carta_selecionada = function() {
				aux.select(cardIndex, isBank);
			}
		}, false);
		window.addEventListener("keydown", function (e) {
			if (e.keyCode == 13 && carta_selecionada !== null) carta_selecionada();
		});
		// Right click allows to see more details about the selected card
		elem.addEventListener('contextmenu', async (e) => {
			e.preventDefault();
			let container = new CardContainer();
			container.cards = [new Card(index, card_data, null)];
			try {
				Carousel.curr.cancel();
			} catch (err) { }
			await ui.viewCardsInContainer(container);
		}, false);

		return bankID;
	}

	// Updates the card preview elements when any changes are made to the deck
	update() {
		for (let x of this.bank) {
			if (x.count)
				x.elem.classList.remove("hide");
			else
				x.elem.classList.add("hide");
		}
		let total = 0,
			units = 0,
			special = 0,
			strength = 0,
			hero = 0;
		for (let x of this.deck) {
			let card_data = card_dict[x.index];
			if (x.count)
				x.elem.classList.remove("hide");
			else
				x.elem.classList.add("hide");
			total += x.count;
			if (card_data.deck.startsWith("special") || card_data.deck.startsWith("weather")) {
				special += x.count;
				continue;
			}
			units += x.count;
			strength += card_data.strength * x.count;
			if (card_data.ability.split(" ").includes("hero"))
				hero += x.count;
		}
		this.stats = {
			total: total,
			units: units,
			special: special,
			strength: strength,
			hero: hero
		};
		this.updateStats();
	}

	// Updates and displays the statistics describing the cards currently in the deck
	updateStats() {
		let stats = document.getElementById("deck-stats");
		stats.children[1].innerHTML = this.stats.total;
		stats.children[3].innerHTML = this.stats.units + (this.stats.units < 22 ? "/22" : "");
		stats.children[5].innerHTML = this.stats.special + "/10";
		stats.children[7].innerHTML = this.stats.strength;
		stats.children[9].innerHTML = this.stats.hero;

		stats.children[3].style.color = this.stats.units < 22 ? "red" : "";
		stats.children[5].style.color = (this.stats.special > 10) ? "red" : "";
	}

	// Opens a Carousel to allow the client to select a leader for their deck
	selectLeader() {
		let container = new CardContainer();
		container.cards = this.leaders.map(c => {
			let card = new Card(c.index, c.card, player_me);
			card.data = c;
			return card;
		});

		let index = this.leaders.indexOf(this.leader);
		ui.queueCarousel(container, 1, (c, i) => {
			let data = c.cards[i].data;
			this.leader = data;
			getPreviewElem(this.leader_elem.children[1], data.card);
		}, () => true, false, true);
		Carousel.curr.index = index;
		Carousel.curr.update();
	}

	// Opens a Carousel to allow the client to select a faction for their deck
	selectFaction() {
		let container = new CardContainer();
		container.cards = Object.keys(factions).map(f => {
			return {
				abilities: [f],
				filename: f,
				desc_name: factions[f].name,
				desc: factions[f].description,
				faction: "faction"
			};
		});
		let index = container.cards.reduce((a, c, i) => c.filename === this.faction ? i : a, 0);
		ui.queueCarousel(container, 1, (c, i) => {
			let change = this.setFaction(c.cards[i].filename);
			if (!change)
				return;
			this.makeBank(c.cards[i].filename);
			this.update();
		}, () => true, false, true);
		Carousel.curr.index = index;
		Carousel.curr.update();
	}

	// Called when client selects s a preview card. Moves it from bank to deck or vice-versa then updates;
	select(index, isBank) {
		carta_selecionada = null;
		if (isBank) {
			tocar("menu_buy", false);
			this.add(index, this.deck);
			this.remove(index, this.bank);
		} else {
			tocar("discard", false);
			this.add(index, this.bank);
			this.remove(index, this.deck);
		}
		this.update();
	}

	// Adds a card to container (Bank or deck)
	add(index, cards) {
		let id = cards[index];
		id.elem.getElementsByClassName("card-count")[0].innerHTML = ++id.count;
		id.elem.getElementsByClassName("card-count")[0].classList.remove("hide");
	}

	// Removes a card from container (bank or deck)
	remove(index, cards) {
		let id = cards[index];
		id.elem.getElementsByClassName("card-count")[0].innerHTML = --id.count;
		if (id.count === 0)
			id.elem.getElementsByClassName("card-count")[0].classList.add("hide");
	}

	// Removes all elements in the bank and deck
	clear() {
		while (this.bank_elem.firstChild)
			this.bank_elem.removeChild(this.bank_elem.firstChild);
		while (this.deck_elem.firstChild)
			this.deck_elem.removeChild(this.deck_elem.firstChild);
		this.bank = [];
		this.deck = [];
		this.stats = {};
	}

	// Verifies current deck, creates the players and their decks, then starts a new game
	startNewGame() {
		openFullscreen();
		let warning = "";
		if (this.stats.units < 22)
			warning += "Your deck must have at least 22 unit cards. \n";
		if (this.stats.special > 10)
			warning += "Your deck must have no more than 10 special cards. \n";
		if (warning != "") {
			return aviso(warning);
		}

		let me_deck = {
			faction: this.faction,
			leader: this.leader,
			cards: this.deck.filter(x => x.count > 0),
            title: this.me_deck_title
		};

		if (game.randomOPDeck || !this.start_op_deck) {
			this.start_op_deck = JSON.parse(JSON.stringify(premade_deck[randomInt(Object.keys(premade_deck).length)]));
			this.start_op_deck.cards = this.start_op_deck.cards.map(c => ({
				index: c[0],
				count: c[1]
			}));

			let leaders = Object.keys(card_dict).map(cid => {
				return {
					index: cid,
					card: card_dict[cid]
				};
			}).filter(c => c.card.row === "leader" && c.card.deck === this.start_op_deck.faction);
			this.start_op_deck.leader = leaders[randomInt(leaders.length)];
        }
		
		player_me = new Player(0, "Player 1", me_deck);
		player_op = new Player(1, "Player 2", this.start_op_deck);

		this.elem.classList.add("hide");
		called_leader = false;
		tocar("game_opening", false);
		game.startGame();
	}

	// Converts the current deck to a JSON string
	deckToJSON() {
		let obj = {
			faction: this.faction,
			leader: this.leader.index,
			cards: this.deck.filter(x => x.count > 0).map(x => [x.index, x.count])
		};
		return JSON.stringify(obj);
	}

	// Select a premade deck
	selectDeck() {
		let container = new CardContainer();
		container.cards = Object.values(premade_deck).map(d => {
			let deck = d;
			return {
				abilities: [deck["faction"]],
				name: card_dict[deck["leader"]]["name"],
				row: "leader",
				filename: card_dict[deck["leader"]]["filename"],
				desc_name: deck["title"],
				desc: "<p><b>Faction ability:</b> " + factions[deck["faction"]]["description"]+"</p><p><b>Leader ability:</b> "+ability_dict[card_dict[deck["leader"]]["ability"]].description+"</p><p><b>Deck description:</b> "+deck["description"],
				faction: deck["faction"]
			};
		});
		let index = container.cards.reduce((a, c, i) => c.faction === this.faction ? i : a, 0);
		ui.queueCarousel(container, 1, (c, i) => {
			this.me_deck_index = i;
			this.setFaction(c.cards[i].faction);
			this.deckFromJSON(premade_deck[i],false);
		}, () => true, false, true);
		Carousel.curr.index = this.me_deck_index;
		Carousel.curr.update();
	}

	selectOPDeck() {
		let container = new CardContainer();
		// Adding first the option to select a random deck
		container.cards = [{ abilities: [], name: "Random deck", row: "faction", filename: "random", desc_name: "Random deck", desc: "A random deck from the pool that will change every game.", faction: "faction" }];
		container.cards = container.cards.concat(Object.values(premade_deck).map(d => {
			let deck = d;
			return {
				abilities: [deck["faction"]],
				name: card_dict[deck["leader"]]["name"],
				row: "leader",
				filename: card_dict[deck["leader"]]["filename"],
				desc_name: deck["title"],
				desc: "<p><b>Faction ability:</b> " + factions[deck["faction"]]["description"] + "</p><p><b>Leader ability:</b> " + ability_dict[card_dict[deck["leader"]]["ability"]].description + "</p><p><b>Deck description:</b> " + deck["description"],
				faction: deck["faction"]
			};
		}));
		ui.queueCarousel(container, 1, (c, i) => {
			this.op_deck_index = i;
			if (i === 0) {
				game.randomOPDeck = true;
				document.getElementById("op-deck-name").innerHTML = "Random deck";
			} else {
				this.start_op_deck = JSON.parse(JSON.stringify(premade_deck[i-1]));
				this.start_op_deck.cards = this.start_op_deck.cards.map(c => ({
					index: c[0],
					count: c[1]
				}));
				this.start_op_deck.leader = { index: this.start_op_deck.leader, card: card_dict[this.start_op_deck.leader] };
				document.getElementById("op-deck-name").innerHTML = premade_deck[i-1]["title"];
				game.randomOPDeck = false;
			}
		}, () => true, false, true);
		Carousel.curr.index = this.op_deck_index;
		Carousel.curr.update();
    }

	// Called by the client to downlaod the current deck as a JSON file
	downloadDeck() {
		let json = this.deckToJSON();
		let str = "data:text/json;charset=utf-8," + encodeURIComponent(json);
		let hidden_elem = document.getElementById('download-json');
		hidden_elem.href = str;
		hidden_elem.download = "MyGwentDeck.json";
		hidden_elem.click();
	}

	// Called by the client to upload a JSON file representing a new deck
	uploadDeck() {
		let files = document.getElementById("add-file").files;
		if (files.length <= 0)
			return false;
		let fr = new FileReader();
		fr.onload = e => {
			try {
				this.deckFromJSON(e.target.result,true);
			} catch (e) {
				aviso("Uploaded deck is not formatted correctly!");
			}
		}
		fr.readAsText(files.item(0));
		document.getElementById("add-file").value = "";
		openFullscreen();
	}

	// Creates a deck from a JSON file's contents and sets that as the current deck
	// Notifies client with warnings if the deck is invalid
	deckFromJSON(json,parse) {
		let deck;
		if (parse) {
			try {
				deck = JSON.parse(json);
			} catch (e) {
				aviso("Uploaded deck is not parsable!");
				return;
			}
		} else {
			deck = JSON.parse(JSON.stringify(json));
        }
		let warning = "";
		if (card_dict[deck.leader].row !== "leader")
			warning += "'" + card_dict[deck.leader].name + "' is cannot be used as a leader\n";
		if (deck.faction != card_dict[deck.leader].deck)
			warning += "Leader '" + card_dict[deck.leader].name + "' doesn't match deck faction '" + deck.faction + "'.\n";

		let cards = deck.cards.filter(c => {
				let card = card_dict[c[0]];
				if (!card) {
					warning += "ID " + c[0] + " does not correspond to a card.\n";
					return false
				}
				if (!([deck.faction, "neutral", "special", "weather"].includes(card.deck)
					|| (["special", "weather"].includes(card.deck.split(" ")[0]) && card.deck.split(" ").includes(deck.faction)))){
					warning += "'" + card.name + "' cannot be used in a deck of faction type '" + deck.faction + "'\n";
					return false;
				}
				if (card.count < c[1]) {
					console.log(card);
					warning += "Deck contains " + c[1] + "/" + card.count + " available " + card_dict[c[0]].name + " cards\n";
					return false;
				}
				return true;
			})
			.map(c => ({
				index: c[0],
				count: Math.min(c[1], card_dict[c[0]].count)
			}));

		if (warning) {
			tocar("warning", false);
			if (!confirm(warning + "\n\n\Continue importing deck?")) {
				tocar("warning", false);
				return;
			}
		}
		this.setFaction(deck.faction, true);
		if (card_dict[deck.leader].row === "leader" && deck.faction === card_dict[deck.leader].deck) {
			this.leader = this.leaders.filter(c => c.index === deck.leader)[0];
			getPreviewElem(this.leader_elem.children[1], this.leader.card);
        }
        this.me_deck_title = deck.title;
		this.makeBank(deck.faction, cards);
		this.update();
	}
}

// Translates a card between two containers
async function translateTo(card, container_source, container_dest) {
	if (!container_dest || !container_source)
		return;
	if (container_dest === player_op.hand && container_source === player_op.deck)
		return;

	let elem = card.elem;
	let source = !container_source ? card.elem : getSourceElem(card, container_source, container_dest);
	let dest = getDestinationElem(card, container_source, container_dest);
	if (!isInDocument(elem))
		source.appendChild(elem);
	let x = trueOffsetLeft(dest) - trueOffsetLeft(elem) + dest.offsetWidth / 2 - elem.offsetWidth;
	let y = trueOffsetTop(dest) - trueOffsetTop(elem) + dest.offsetHeight / 2 - elem.offsetHeight / 2;
	if (container_dest instanceof Row && container_dest.cards.length !== 0 && !card.isSpecial()) {
		x += (container_dest.getSortedIndex(card) === container_dest.cards.length) ? elem.offsetWidth / 2 : -elem.offsetWidth / 2;
	}
	if (card.holder.controller instanceof ControllerAI)
		x += elem.offsetWidth / 2;
	if (container_source instanceof Row && container_dest instanceof Grave && !card.isSpecial()) {
		let mid = trueOffset(container_source.elem, true) + container_source.elem.offsetWidth / 2;
		x += trueOffset(elem, true) - mid;
	}
	if (container_source instanceof Row && container_dest === player_me.hand)
		y *= 7 / 8;
	await translate(elem, x, y);

	// Returns true if the element is visible in the viewport
	function isInDocument(elem) {
		return elem.getBoundingClientRect().width !== 0;
	}

	// Returns the true offset of a nested element in the viewport
	function trueOffset(elem, left) {
		let total = 0;
		let curr = elem;
		while (curr) {
			total += (left ? curr.offsetLeft : curr.offsetTop);
			curr = curr.parentElement;
		}
		return total;
	}

	function trueOffsetLeft(elem) {
		return trueOffset(elem, true);
	}

	function trueOffsetTop(elem) {
		return trueOffset(elem, false);
	}

	// Returns the source container's element to transition from
	function getSourceElem(card, source, dest) {
		if (source instanceof HandAI)
			return source.hidden_elem;
		if (source instanceof Deck)
			return source.elem.children[source.elem.children.length - 2];
		return source.elem;
	}

	// Returns the destination container's element to transition to
	function getDestinationElem(card, source, dest) {
		if (dest instanceof HandAI)
			return dest.hidden_elem;
		if (card.isSpecial() && dest instanceof Row)
			//return dest.elem_special;
			return dest.special.elem;
		if (dest instanceof Row || dest instanceof Hand || dest instanceof Weather) {
			if (dest.cards.length === 0)
				return dest.elem;
			let index = dest.getSortedIndex(card);
			let dcard = dest.cards[index === dest.cards.length ? index - 1 : index];
			return dcard.elem;
		}
		return dest.elem;
	}
}

// Translates an element by x from the left and y from the top
async function translate(elem, x, y) {
	let vw100 = 100 / document.getElementById("dimensions").offsetWidth;
	x *= vw100;
	y *= vw100;
	elem.style.transform = "translate(" + x + "vw, " + y + "vw)";
	let margin = elem.style.marginLeft;
	elem.style.marginRight = -elem.offsetWidth * vw100 + "vw";
	elem.style.marginLeft = "";
	await sleep(499);
	elem.style.transform = "";
	elem.style.position = "";
	elem.style.marginLeft = margin;
	elem.style.marginRight = margin;
}

// Fades out an element until hidden over the duration
async function fadeOut(elem, duration, delay) {
	await fade(false, elem, duration, delay);
}

// Fades in an element until opaque over the duration
async function fadeIn(elem, duration, delay) {
	await fade(true, elem, duration, delay);
}

// Fades an element over a duration 
async function fade(fadeIn, elem, dur, delay) {
    if (delay)
        await sleep(delay);
	let op = fadeIn ? 0.1 : 1;
	elem.style.opacity = op;
	elem.style.filter = "alpha(opacity=" + (op * 100) + ")";
	if (fadeIn)
        elem.classList.remove("hide");
    let timer = setInterval(async function () {
        op += (fadeIn ? 0.1 : -0.1);
		if (op >= 1) {
			clearInterval(timer);
			return;
		} else if (op <= 0.1) {
			elem.classList.add("hide");
			elem.style.opacity = "";
			elem.style.filter = "";
			clearInterval(timer);
			return;
		}
		elem.style.opacity = op;
		elem.style.filter = "alpha(opacity=" + (op * 100) + ")";
	}, dur / 10);
}

// Get Image paths   
function iconURL(name, ext = "png") {
	return imgURL("icons/" + name, ext);
}

function largeURL(name, ext = "jpg") {
	return imgURL("lg/" + name, ext)
}

function smallURL(name, ext = "jpg") {
	return imgURL("sm/" + name, ext);
}

function bottomBgURL() {
	return imgURL("icons/gwent_bottom_bg","png");
}

function imgURL(path, ext) {
	return "url('img/" + path + "." + ext + "')";
}

function getPreviewElem(elem, card, nb = 0) {
	// Cleaning existing child nodes
	while (elem.hasChildNodes()) {
		elem.removeChild(elem.lastChild);
	}
	elem.classList.remove("hero");
	elem.classList.remove("faction");
	
	let c_abilities = "";
	if ("ability" in card) {
		c_abilities = card.ability.split(" ");
	} else {
		c_abilities = card.abilities;
	}
	let faction = ""
	if ("deck" in card) {
		faction = card.deck.split(" ")[0];	// Cleaning in case of special/weather cards being faction specific
	} else {
		faction = card.faction;
    }

	elem.style.backgroundImage = smallURL(faction + "_" + card.filename);

	if (faction == "faction") {
		elem.classList.add("faction");
		return elem;
	}

	if (card.row != "leader" && !faction.startsWith("special") && faction != "neutral" && !faction.startsWith("weather")) {
		let factionBand = document.createElement("div");
		factionBand.style.backgroundImage = iconURL("faction-band-" + faction);
		factionBand.classList.add("card-large-faction-band");
		elem.appendChild(factionBand);
	}
	
	let cardbg = document.createElement("div");
	cardbg.style.backgroundImage = bottomBgURL();
	cardbg.classList.add("card-large-bg");
	elem.appendChild(cardbg);


	let card_name = document.createElement("div");
	card_name.classList.add("card-large-name");
	card_name.appendChild(document.createTextNode(card.name));
	elem.appendChild(card_name);

	if ("quote" in card) {
		let quote_elem = document.createElement("div");
		quote_elem.classList.add("card-large-quote");
		quote_elem.appendChild(document.createTextNode(card.quote));
		elem.appendChild(quote_elem);
    }

	// Nothing else to display for leaders
	if (card.row === "leader") {
		return elem;
    }

	let count = document.createElement("div");
	count.innerHTML = nb;
	count.classList.add("card-count");
	cardbg.appendChild(count);
	if (nb == 0) {
		count.classList.add("hide");
	}

	let power = document.createElement("div");
	power.classList.add("card-large-power");
	elem.appendChild(power);
	let bg;
	if (c_abilities[0] === "hero" || ("hero" in card && card.hero)) {
		bg = "power_hero";
		elem.classList.add("hero");
	} else if (faction.startsWith("weather")) {
		bg = "power_" + c_abilities[0];
	} else if (faction.startsWith("special")) {
		let str = c_abilities[0];
		if (str === "shield_c" || str == "shield_r" || str === "shield_s")
			str = "shield";
		bg = "power_" + str;
		elem.classList.add("special");
	} else {
		bg = "power_normal";
	}
	power.style.backgroundImage = iconURL(bg);

	let row = document.createElement("div");
	row.classList.add("card-large-row");
	elem.appendChild(row);
	if (card.row === "close" || card.row === "ranged" || card.row === "siege" || card.row === "agile") {
		let num = document.createElement("div");
		if ("strength" in card) { 
			num.appendChild(document.createTextNode(card.strength));
		} else {
		num.appendChild(document.createTextNode(card.basePower));
		}
		num.classList.add("card-large-power-strength");
		power.appendChild(num);
		row.style.backgroundImage = iconURL("card_row_" + card.row);
	}

	if (c_abilities.length > 0) {
		let abi = document.createElement("div");
		abi.classList.add("card-large-ability");
		elem.appendChild(abi);

		if (!faction.startsWith("special") && !faction.startsWith("weather") && c_abilities.length > 0 && c_abilities[c_abilities.length - 1] != "hero") {
			let str = c_abilities[c_abilities.length - 1];
			if (str === "cerys")
				str = "muster";
			if (str.startsWith("avenger"))
				str = "avenger";
			if (str === "scorch_c" || str == "scorch_r" || str === "scorch_s")
				str = "scorch_combat";
			if (str === "shield_c" || str == "shield_r" || str === "shield_s")
				str = "shield";
			abi.style.backgroundImage = iconURL("card_ability_" + str);
		} else if (card.row === "agile") {
			abi.style.backgroundImage = iconURL("card_ability_" + "agile");
		}

		// In case of double abilities
		if ((c_abilities.length > 1 && !(c_abilities[0] === "hero")) || (c_abilities.length > 2 && c_abilities[0] === "hero")) {
			let abi2 = document.createElement("div");
			abi2.classList.add("card-large-ability-2");
			elem.appendChild(abi2);

			let str = c_abilities[c_abilities.length - 2];
			if (str === "cerys")
				str = "muster";
			if (str.startsWith("avenger"))
				str = "avenger";
			if (str === "scorch_c" || str == "scorch_r" || str === "scorch_s")
				str = "scorch_combat";
			if (str === "shield_c" || str == "shield_r" || str === "shield_s")
				str = "shield";
			abi2.style.backgroundImage = iconURL("card_ability_" + str);
        }
	}

	return elem;
}

// Returns true if n is an Number
function isNumber(n) {
	return !isNaN(parseFloat(n)) && isFinite(n);
}

// Returns true if s is a String
function isString(s) {
	return typeof (s) === 'string' || s instanceof String;
}

// Returns a random integer in the range [0,n)
function randomInt(n) {
	return Math.floor(Math.random() * n);
}

// Pauses execution until the passed number of milliseconds as expired
function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// Suspends execution until the predicate condition is met, checking every ms milliseconds
function sleepUntil(predicate, ms) {
	return new Promise(resolve => {
		let timer = setInterval(function () {
			if (predicate()) {
				clearInterval(timer);
				resolve();
			}
		}, ms)
	});
}

// Initializes the interractive YouTube object
function onYouTubeIframeAPIReady() {
	ui.initYouTube();
}

/*----------------------------------------------------*/

var ui = new UI();
var board = new Board();
var weather = new Weather();
var game = new Game();
var player_me, player_op;

ui.enablePlayer(false);
let dm = new DeckMaker();

document.addEventListener('contextmenu', event => event.preventDefault());

document.onkeydown = function (e) {
	if (e.keyCode != 123) {
		if (document.getElementById("carousel").className != "hide") {
			switch (e.keyCode) {
				case 13:
					Carousel.curr.select(e);
					break;
				case 37:
					Carousel.curr.shift(e, -1);
					break;
				case 39:
					Carousel.curr.shift(e, 1);
					break;
			}
		} else if (document.getElementsByClassName("hover_un")[0].innerText.length > 1) {
			switch(e.keyCode) {
				case 69:
					Popup.curr.selectYes();
					break;
				case 81:
					Popup.curr.selectNo();
					break;
			}
		} else if (!iniciou && isLoaded && (e.keyCode == 13 || e.keyCode == 69)) inicio();
	} else return false;
}

var elem_principal = document.documentElement;

function openFullscreen() {
	try {
		if (elem_principal.requestFullscreen) elem_principal.requestFullscreen();
		else if (elem_principal.webkitRequestFullscreen) elem_principal.webkitRequestFullscreen();
		else if (elem_principal.msRequestFullscreen) elem_principal.msRequestFullscreen();
	} catch(err) {}
}

var lastSound = "";

function tocar(arquivo, pararMusica) {
	if (arquivo != lastSound && arquivo != "") {
		var s = new Audio("sfx/" + arquivo + ".mp3");
		if (pararMusica && ui.youtube.getPlayerState() === YT.PlayerState.PLAYING) {
			ui.youtube.pauseVideo();
			ui.toggleMusic_elem.classList.add("fade");
		}
		lastSound = arquivo;
		if (iniciou) s.play();
		setTimeout(function() {
			lastSound = "";
		}, 50);
	}
}

function aviso(texto) {
	tocar("warning", false);
	setTimeout(function() {
		alert(texto);
		document.getElementById("start-game").blur();
		tocar("warning", false);
	}, 150);
}

function somCarta() {
	var classes = ["card", "card-lg"];
	for (var i = 0; i < classes.length; i++) {
		var cartas = document.getElementsByClassName(classes[i]);
		for (var j = 0; j < cartas.length; j++) {
			if (cartas[j].id != "no_sound" && cartas[j].id != "no_hover") cartas[j].addEventListener("mouseover", function() {
				tocar("card", false);
			});
		}
	}
	var tags = ["label", "a", "button"];
	for (var i = 0; i < tags.length; i++) {
		var rec = document.getElementsByTagName(tags[i]);
		for (var j = 0; j < rec.length; j++) rec[j].addEventListener("mouseover", function() {
			tocar("card", false);
		});
	}
	var ids = ["pass-button", "toggle-music"];
	for (var i = 0; i < ids.length; i++) document.getElementById(ids[i]).addEventListener("mouseover", function() {
		tocar("card", false);
	});
}

function cartaNaLinha(id, carta) {
	if (id.charAt(0) == "f") {
		if (!carta.hero) {
			if (carta.name != "Decoy") {
				var linha = parseInt(id.charAt(1));
				if (linha == 1 || linha == 6) tocar("common3", false);
				else if (linha == 2 || linha == 5) tocar("common2", false);
				else if (linha == 3 || linha == 4) tocar("common1", false);
			} else tocar("menu_buy", false);
		} else tocar("hero", false);
	}
}

function inicio() {
	var classe = document.getElementsByClassName("abs");
	for (var i = 0; i < classe.length; i++) classe[i].style.display = "none";
	iniciou = true;
	tocar("menu_opening", false);
	openFullscreen();
	iniciarMusica();
}

function iniciarMusica() {
	try {
		if (ui.youtube.getPlayerState() !== YT.PlayerState.PLAYING) {
			ui.youtube.playVideo();
			ui.toggleMusic_elem.classList.remove("fade");
		}
	} catch(err) {}
}

function cancelaClima() {
	if (carta_c) {
		ui.cancel();
		hover_row = false;
		setTimeout(function() {
			hover_row = true;
		}, 100);
	}
}

var iniciou = false, isLoaded = false;

var playingOnline;

window.onload = function() {
	dimensionar();
	playingOnline = window.location.href == "https://randompianist.github.io/gwent-classic-v2.0/";
	document.getElementById("load_text").style.display = "none";
	document.getElementById("button_start").style.display = "inline-block";
	document.getElementById("deck-customization").style.display = "";
	document.getElementById("toggle-music").style.display = "";
	document.getElementsByTagName("main")[0].style.display = "";
	document.getElementById("button_start").addEventListener("click", function() {
		inicio();
    });
    if (isMobile) {
        try {
            window.screen.orientation.lock("landscape");
        } catch (err) { }
    }
	isLoaded = true;
}

window.onresize = function() {
	dimensionar();
}

function dimensionar() {
	var prop = window.innerWidth / window.innerHeight;
	var dim = document.getElementById("dimensions").offsetHeight;
	document.getElementById("very_start_bg2").style.height = prop < 1.8 ? (parseInt(dim * 0.94) - 8) + "px" : "";
	document.getElementById("very_start").style.paddingTop = "";
	document.getElementById("very_start").style.paddingTop = parseInt(
		(document.getElementById("very_start_bg2").offsetHeight - document.getElementById("very_start").offsetHeight) / 2
	) + "px";
}

setTimeout(dimensionar(), 300);

function isMobile() {
    if (navigator.userAgentData)
        return navigator.userAgentData.mobile;
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}