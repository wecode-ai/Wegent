//! Account materialized direct objects, including repeated indirect-object reads.
use super::{DecodeBudget, Dictionary, Object};

pub(super) fn charge(object: &Object, budget: &DecodeBudget) -> Result<(), String> {
    budget.consume(std::mem::size_of::<Object>())?;
    match object {
        Object::Name(name) => budget.consume(name.len()),
        Object::String(bytes) => budget.consume(bytes.len()),
        Object::Array(items) => {
            for item in items {
                charge(item, budget)?;
            }
            Ok(())
        }
        Object::Dictionary(dict) => charge_dictionary(dict, budget),
        Object::Stream(stream) => {
            budget.consume(stream.data.len())?;
            charge_dictionary(&stream.dict, budget)
        }
        _ => Ok(()),
    }
}

fn charge_dictionary(dict: &Dictionary, budget: &DecodeBudget) -> Result<(), String> {
    for (key, value) in dict {
        budget.consume(std::mem::size_of::<String>())?;
        budget.consume(key.len())?;
        charge(value, budget)?;
    }
    Ok(())
}
